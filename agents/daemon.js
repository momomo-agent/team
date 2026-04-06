#!/usr/bin/env node
/**
 * DevTeam Daemon - Event-driven orchestrator
 *
 * Event model (from config workflow):
 *   Project start: startup sequence from config
 *   Work loop: parallel agents from config → then agents
 *   Milestone complete: milestoneCheck from config
 *   Safety interval: 10 min
 *   Agent timeout: 60 min
 *   nohup-compatible (no stdin needed)
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const WorkflowEngine = require('./workflow-engine');

const SAFETY_INTERVAL = 10 * 60 * 1000; // 10 min
const AGENT_TIMEOUT = 2 * 60 * 60 * 1000;   // 2 hours
const RUNNER = path.join(__dirname, 'runner.js');
const DEVTEAM_ROOT = path.join(__dirname, '..');
const DEFAULT_WORKFLOW = 'dev-team';
const DEFAULT_CONFIG_PATH = path.join(DEVTEAM_ROOT, 'configs', DEFAULT_WORKFLOW, 'config.json');

const EventBus = require('../lib/event-bus');
const DevTeamMonitor = require('./monitor');

class TeamDaemon {
  constructor(projectDir, opts) {
    opts = opts || {};
    this.projectDir = projectDir;
    this.running = false;
    this.busy = false;
    this.perfMonitorInterval = null;
    
    // Event bus (append-only log + pub/sub)
    this.eventBus = new EventBus(projectDir);
    
    // Legacy event system
    this.eventHandlers = {}; // { eventName: [handler1, handler2, ...] }
  }

  // --- Event System ---
  
  emit(event, data) {
    const handlers = this.eventHandlers[event] || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (e) {
        this.log('error', 'event', `Handler error for ${event}: ${e.message}`);
      }
    });
  }

  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
  }

  once(event, handler) {
    const wrapper = (data) => {
      handler(data);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  off(event, handler) {
    if (!this.eventHandlers[event]) return;
    this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
  }

  // --- Config Loading ---

  loadWorkflowConfig() {
    var projectConfigPath = path.join(this.projectDir, '.team/config.json');
    var projectConfig = {};
    try { projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')); } catch {}

    var defaultConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

    return {
      version: projectConfig.version || defaultConfig.version,
      workflow: projectConfig.workflow || defaultConfig.workflow,
      agents: projectConfig.agents || defaultConfig.agents,
      git: projectConfig.git || defaultConfig.git || {},
      notify: projectConfig.notify || defaultConfig.notify || {}
    };
  }

  // --- Condition Evaluation ---

  // --- Structured Logging (Task 7) ---

  log(event, agent, details) {
    var entry = {
      time: new Date().toISOString(),
      event: event,
      agent: agent || null,
      details: details || null
    };

    // Task 4: Add performance metrics
    if (event === 'agent_start' || event === 'agent_complete' || event === 'group_complete') {
      var mem = process.memoryUsage();
      entry.performance = {
        memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
        memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        cpuUser: process.cpuUsage().user / 1000000,
        cpuSystem: process.cpuUsage().system / 1000000
      };
    }

    // Console output
    console.log('[' + ts() + '] [' + event + '] ' + (agent || '') + ' ' + (details || ''));

    // Write to events.log via EventBus
    // Write to events.log via EventBus (single source of truth for all events)
    this.eventBus.emit(event, agent, { details: details, performance: entry.performance });
  }

  // --- Agent Execution ---

  runAgent(agentType) {
    var self = this;
    return new Promise(function(resolve) {
      var baseType = agentType.replace(/-\d+$/, '');
      // Agent description: from config first, fallback to agent type name
      var agentConfig = (self.config && self.config.agents && self.config.agents[baseType]) || {};
      var desc = agentConfig.description || baseType;

      self.log('agent_start', agentType, desc);
      self.updateAgentStatus(agentType, 'running', desc);

      var proc = spawn('node', [RUNNER, agentType, self.projectDir], {
        stdio: ['ignore', 'inherit', 'inherit'], // no stdin (nohup-compatible)
        detached: true // create process group so we can kill the whole tree
      });

      var timedOut = false;
      var timeout = setTimeout(function() {
        timedOut = true;
        // Kill the entire process group (runner + claude + child tools)
        try { process.kill(-proc.pid, 'SIGTERM'); } catch(e) {
          try { proc.kill('SIGTERM'); } catch(e2) {}
        }
      }, AGENT_TIMEOUT);

      proc.on('close', function(code) {
        clearTimeout(timeout);

        if (timedOut) {
          // Agent timed out — don't retry, just fail and move on
          self.updateAgentStatus(agentType, 'timeout', null);
          self.log('error', agentType, 'timed out after ' + (AGENT_TIMEOUT/1000) + 's, skipping');
          self.emit('agent_complete', { agent: agentType, success: false, timeout: true });
          resolve(false);
          return;
        }

        if (code === 0) {
          self.updateAgentStatus(agentType, 'idle', null);
          self.log('agent_complete', agentType, 'completed successfully');

          // Generic success: reset fail count for agents with onFail config
          if (!self._failCounts) self._failCounts = {};
          self._failCounts[baseType] = 0;

          // PM 完成后发送 kanban_updated 事件
          if (baseType === 'pm') {
            try {
              var kanban = self.getKanban();
              self.emit('kanban_updated', kanban);
            } catch (e) {
              self.log('error', 'pm', 'Failed to read kanban: ' + e.message);
            }
          }

          // Auto git commit from config: agent-level or global
          var config = self.loadWorkflowConfig();
          var agentCfg = (config.agents && config.agents[baseType]) || {};
          var shouldCommit = agentCfg.gitCommit || (config.git && config.git.commitPerTask && agentCfg.scalable);
          if (shouldCommit) {
            try {
              var prefix = agentCfg.gitPrefix || baseType;
              execSync('git add -A && git diff --cached --quiet || git commit -m "' + prefix + ': ' + agentType + ' completed"', {
                cwd: self.projectDir,
                stdio: 'pipe'
              });
            } catch {}
          }

          // Emit agent_complete event
          self.emit('agent_complete', { agent: agentType, success: true });

          resolve(true);
        } else {
          // Generic onFail handling from config
          if (!self._failCounts) self._failCounts = {};
          self._failCounts[baseType] = (self._failCounts[baseType] || 0) + 1;

          var failAgentCfg = (self.config && self.config.agents && self.config.agents[baseType]) || {};
          var onFail = failAgentCfg.onFail;
          if (onFail && onFail.maxRetries && self._failCounts[baseType] >= onFail.maxRetries) {
            self.log('error', baseType, 'Failed ' + onFail.maxRetries + ' times');
            if (onFail.fallbackShell) {
              try {
                execSync(onFail.fallbackShell, { cwd: self.projectDir, stdio: 'pipe' });
                self.log('workflow', baseType, 'Fallback executed: ' + onFail.fallbackShell);
              } catch {}
            }
            self._failCounts[baseType] = 0;
            resolve(true);
            return;
          }

          // Task 4: Error Recovery — retry once on failure
          var statusPath = path.join(self.projectDir, '.team/agent-status.json');
          var all = {};
          try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
          var retryCount = (all[agentType] && all[agentType].retryCount) || 0;

          if (retryCount < 1) {
            self.log('error', agentType, 'failed (code=' + code + '), retrying (attempt ' + (retryCount + 1) + ')');
            self.updateAgentStatus(agentType, 'retrying', null, retryCount + 1);
            // Retry once
            self.runAgent(agentType).then(resolve);
          } else {
            self.updateAgentStatus(agentType, 'error', null, retryCount);
            self.log('error', agentType, 'failed (code=' + code + ') after retry, marking as error');
            
            // Emit agent_complete event (failure)
            self.emit('agent_complete', { agent: agentType, success: false });
            
            resolve(false);
          }
        }
      });

      proc.on('error', function(err) {
        clearTimeout(timeout);
        self.updateAgentStatus(agentType, 'error', err.message);
        self.log('error', agentType, 'spawn error: ' + err.message);
        resolve(false);
      });
    });
  }

  updateAgentStatus(agentType, status, task, retryCount) {
    var statusPath = path.join(this.projectDir, '.team/agent-status.json');
    var all = {};
    try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    all[agentType] = {
      status: status,
      lastRun: new Date().toISOString(),
      currentTask: task || null,
      retryCount: retryCount != null ? retryCount : (all[agentType] && all[agentType].retryCount) || 0
    };
    fs.writeFileSync(statusPath, JSON.stringify(all, null, 2));
  }

  // --- Notifications ---

  async notify(title, message, event) {
    var config = this.loadWorkflowConfig();
    var notifyConfig = config.notify || {};

    // Priority 1: OpenClaw session
    if (notifyConfig.openclaw && notifyConfig.openclaw.sessionKey) {
      try {
        var sessionKey = notifyConfig.openclaw.sessionKey;
        var notifyMsg = '[DevTeam: ' + title + '] ' + message;
        execSync('openclaw sessions send --session "' + sessionKey + '" "' + notifyMsg.replace(/"/g, '\\"') + '"', { timeout: 5000 });
      } catch (err) {
        // Fallback to other methods if OpenClaw fails
        console.error('[notify] OpenClaw failed:', err.message);
      }
    }

    // Priority 2: Webhooks
    if (notifyConfig.webhooks && Array.isArray(notifyConfig.webhooks)) {
      var projectConfig = {};
      try { projectConfig = JSON.parse(fs.readFileSync(path.join(this.projectDir, '.team/config.json'), 'utf8')); } catch {}
      var projectName = (projectConfig && projectConfig.name) || path.basename(this.projectDir);

      for (var i = 0; i < notifyConfig.webhooks.length; i++) {
        var hook = notifyConfig.webhooks[i];
        if (!hook.url) continue;

        // Event filter
        var events = hook.events || ['*'];
        if (events.indexOf('*') === -1 && event && events.indexOf(event) === -1) continue;

        var payload = {
          project: projectName,
          title: title,
          message: message,
          event: event || 'notification',
          timestamp: new Date().toISOString()
        };

        // Fire and forget
        try {
          var https = require('https');
          var http = require('http');
          var urlMod = require('url');
          var parsed = urlMod.parse(hook.url);
          var client = parsed.protocol === 'https:' ? https : http;
          var postData = JSON.stringify(payload);

          var req = client.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
          }, function() {});
          req.on('error', function() {});
          req.write(postData);
          req.end();
        } catch {}
      }
    }

    // Priority 3: macOS notification (always run if enabled)
    if (notifyConfig.macos) {
      try {
        execSync('osascript -e \'display notification "' + message + '" with title "DevTeam: ' + title + '"\'');
      } catch {}
    }
  }

  // --- CR Checking (Task 1) ---

  // ─── Change Request System ───
  //
  // Core principles:
  //   1. Escalation: downstream → direct upstream only (no skipping levels)
  //   2. Quality gate: evidence + impact + proposal required
  //
  // Config (optional):
  //   cr.hierarchy: ["pm", "architect", "tech_lead", "developer", "tester"]
  //   cr.staleAfterHours: 48
  //
  // CR format:
  //   { id, from, to, evidence, impact, proposal, status, severity, created }

  getCRHierarchy() {
    return (this.config && this.config.cr && this.config.cr.hierarchy) ||
      ['pm', 'architect', 'tech_lead', 'developer', 'tester'];
  }

  getUpstream(role) {
    const hierarchy = this.getCRHierarchy();
    const idx = hierarchy.indexOf(role);
    if (idx <= 0) return null; // top of chain or not found
    return hierarchy[idx - 1];
  }

  submitCR(cr) {
    // Quality gate: must have evidence, impact, proposal
    const missing = [];
    if (!cr.evidence) missing.push('evidence');
    if (!cr.impact) missing.push('impact');
    if (!cr.proposal) missing.push('proposal');
    if (!cr.from) missing.push('from');

    if (missing.length > 0) {
      this.log('cr', cr.from || 'unknown',
        `[CR-REJECTED] Missing required fields: ${missing.join(', ')}`);
      return { accepted: false, reason: `Missing: ${missing.join(', ')}` };
    }

    // Route to direct upstream only
    const upstream = cr.to || this.getUpstream(cr.from);
    if (!upstream) {
      this.log('cr', cr.from,
        `[CR-REJECTED] ${cr.from} is at top of hierarchy, cannot escalate`);
      return { accepted: false, reason: `${cr.from} has no upstream` };
    }

    // Validate: from must be directly below to (no skipping levels)
    const hierarchy = this.getCRHierarchy();
    const fromIdx = hierarchy.indexOf(cr.from);
    const toIdx = hierarchy.indexOf(upstream);
    if (fromIdx - toIdx !== 1) {
      this.log('cr', cr.from,
        `[CR-REJECTED] ${cr.from} → ${upstream}: must escalate to direct upstream only`);
      return { accepted: false, reason: `Cannot skip levels: ${cr.from} → ${upstream}` };
    }

    // Create CR
    const crId = 'cr-' + Date.now();
    const crData = {
      id: crId,
      from: cr.from,
      to: upstream,
      evidence: cr.evidence,
      impact: cr.impact,
      proposal: cr.proposal,
      severity: cr.severity || 'normal',
      status: 'pending',
      created: new Date().toISOString()
    };

    const crDir = path.join(this.projectDir, '.team/change-requests');
    fs.mkdirSync(crDir, { recursive: true });
    fs.writeFileSync(path.join(crDir, crId + '.json'), JSON.stringify(crData, null, 2));

    this.log('cr', cr.from,
      `[CR] ${crId}: ${cr.from} → ${upstream} | ${cr.impact}`);
    this.emit('cr_submitted', crData);

    return { accepted: true, id: crId, to: upstream };
  }

  reviewCR(crId, decision, resolution) {
    const crPath = path.join(this.projectDir, '.team/change-requests', crId + '.json');
    if (!fs.existsSync(crPath)) return { error: 'CR not found' };

    const cr = JSON.parse(fs.readFileSync(crPath, 'utf8'));

    if (decision === 'accept') {
      cr.status = 'accepted';
      cr.resolution = resolution || cr.proposal;
      cr.reviewedAt = new Date().toISOString();
      fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));

      this.log('cr', cr.to,
        `[CR-ACCEPTED] ${crId}: ${cr.to} accepted, will fix`);
      this.emit('cr_accepted', cr);

    } else if (decision === 'escalate') {
      // Upstream can't fix → escalate to their upstream
      const nextUp = this.getUpstream(cr.to);
      if (!nextUp) {
        cr.status = 'rejected';
        cr.resolution = 'Top of hierarchy, cannot escalate further';
        cr.reviewedAt = new Date().toISOString();
        fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
        this.log('cr', cr.to, `[CR-CEILING] ${crId}: no upstream to escalate to`);
      } else {
        cr.to = nextUp;
        cr.escalatedAt = new Date().toISOString();
        fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
        this.log('cr', cr.to, `[CR-ESCALATED] ${crId}: escalated to ${nextUp}`);
        this.emit('cr_escalated', cr);
      }

    } else if (decision === 'reject') {
      cr.status = 'rejected';
      cr.resolution = resolution || 'Rejected by reviewer';
      cr.reviewedAt = new Date().toISOString();
      fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));

      this.log('cr', cr.to,
        `[CR-REJECTED] ${crId}: ${cr.to} rejected — ${cr.resolution}`);
      this.emit('cr_rejected', cr);
    }

    return { status: cr.status };
  }

  checkPendingCRs() {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return;

    var files;
    try { files = fs.readdirSync(crDir).filter(f => f.endsWith('.json')); } catch { return; }

    const staleHours = (this.config && this.config.cr && this.config.cr.staleAfterHours) || 48;
    const staleMs = staleHours * 60 * 60 * 1000;
    let pendingCount = 0;

    for (const f of files) {
      try {
        const cr = JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8'));
        if (cr.status !== 'pending') continue;
        pendingCount++;

        // Stale CR detection
        const elapsed = Date.now() - new Date(cr.created).getTime();
        if (elapsed > staleMs) {
          cr.status = 'stale';
          cr.resolution = `Auto-staled after ${staleHours}h without review`;
          fs.writeFileSync(path.join(crDir, f), JSON.stringify(cr, null, 2));
          this.log('cr', cr.to, `[CR-STALE] ${cr.id}: pending ${staleHours}h+, auto-staled`);
        }
      } catch {}
    }

    if (pendingCount > 10) {
      this.log('cr', 'system', `[CR-ANOMALY] ${pendingCount} pending CRs — possible noise`);
    }
  }

  hasBlockerCR() {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return false;

    var files;
    try { files = fs.readdirSync(crDir).filter(f => f.endsWith('.json')); } catch { return false; }

    for (const f of files) {
      try {
        const cr = JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8'));
        if (cr.status === 'pending' && cr.severity === 'blocker') return true;
      } catch {}
    }
    return false;
  }

  // --- Task 4: Stuck task detection ---

  checkStuckTasks() {
    var kanban = this.getKanban();
    var inProgress = kanban.inProgress || [];
    if (inProgress.length === 0) return;

    var statusPath = path.join(this.projectDir, '.team/agent-status.json');
    var agentStatus = {};
    try { agentStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}

    // Check if any agents are still running — if none are running but tasks are inProgress, they may be stuck
    var anyRunning = Object.values(agentStatus).some(function(a) { return a.status === 'running'; });
    if (anyRunning) return; // agents still working, not stuck yet

    // Timeout detection: force-mark after 2 hours
    var TaskManager = require(path.join(__dirname, '../lib/task-manager.js'));
    var tm = new TaskManager(this.projectDir, this);
    var now = Date.now();
    var TWO_HOURS = 2 * 60 * 60 * 1000;

    for (var i = 0; i < inProgress.length; i++) {
      var taskId = inProgress[i];
      try {
        var task = tm.getTask(taskId);
        if (!task) continue;

        var updated = new Date(task.updated).getTime();
        var elapsed = now - updated;

        // 超过 2 小时未更新 → timeout
        if (elapsed > TWO_HOURS) {
          tm.updateTask(taskId, { status: 'todo', assignee: null });
          this.log('error', taskId, 'Task timeout (>2h), moved back to todo');
        }
      } catch {}
    }

    // Check for tasks stuck in inProgress > 2h (handled by checkStuckTasks)
    if (inProgress.length > 0) {
      for (var i = 0; i < inProgress.length; i++) {
        var taskId = inProgress[i];
        try {
          tm.updateTask(taskId, { status: 'todo', assignee: null });
          this.log('error', taskId, 'Task stuck in inProgress, moved back to todo');
        } catch {}
      }
    }
  }

  // --- Data Reading ---

  getKanban() {
    // Single source of truth: derive from task.json files via task-manager
    var TaskManager = require('../lib/task-manager');
    var tm = new TaskManager(this.projectDir, this);
    return tm.getKanban();
  }

  // --- Group system (milestone is the default group label) ---

  get groupLabel() {
    var cfg = this.config || {};
    return (cfg.groups && cfg.groups.label) || 'milestones';
  }

  getMilestones() {
    var label = this.groupLabel;
    var p = path.join(this.projectDir, '.team', label, label + '.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { milestones: [] };
    }
  }

  getActiveMilestone() {
    var data = this.getMilestones();
    // active, ready-for-work, in-progress all count as "active" milestone
    return (data.milestones || []).find(function(m) {
      return m.status === 'active' || m.status === 'ready-for-work' || m.status === 'in-progress';
    }) || null;
  }

  isMilestoneComplete() {
    var ms = this.getActiveMilestone();
    if (!ms || !ms.tasks || ms.tasks.length === 0) return false;
    var kanban = this.getKanban();
    var doneSet = new Set(kanban.done || []);
    return ms.tasks.every(function(id) { return doneSet.has(id); });
  }

  // --- Event Handlers (Config-Driven) ---

  async onProjectStart() {
    this.log('group_complete', null, '=== PROJECT START ===');

    var config = this.loadWorkflowConfig();
    this.log('agent_start', 'workflow', 'Config version: ' + config.version);

    const engine = new WorkflowEngine(config, this);
    await engine.execute();
  }

  async onMilestoneComplete() {
    var ms = this.getActiveMilestone();
    var msId = ms ? ms.id : '?';
    var msName = ms ? ms.name : 'Unknown';
    var label = this.groupLabel;
    this.log('group_complete', msId, '=== ' + label.toUpperCase() + ' ' + msId + ' COMPLETE: ' + msName + ' ===');

    await this.notify(label + '完成: ' + msName, msName + ' 已完成，运行 QG + Monitor...', 'group_complete');

    // Ensure review directory exists
    if (ms) {
      var reviewDir = path.join(this.projectDir, '.team', label, msId, 'review');
      if (!fs.existsSync(reviewDir)) {
        fs.mkdirSync(reviewDir, { recursive: true });
      }
    }

    // Run quality gate node from workflow config
    var config = this.loadWorkflowConfig();
    const engine = new WorkflowEngine(config, this);
    const qgNode = (config.groups && config.groups.qgNode) || 'milestone_qg';
    await engine.executeNode(qgNode);
  }

  // --- Task 3: Cross-Validation of Match Percentages ---

  crossValidateMonitors(msId) {
    var gapsDir = path.join(this.projectDir, '.team/gaps');
    var monitors = ['vision', 'prd', 'dbb', 'architecture'];
    var matches = {};

    for (var i = 0; i < monitors.length; i++) {
      var name = monitors[i];
      try {
        var data = JSON.parse(fs.readFileSync(path.join(gapsDir, name + '.json'), 'utf8'));
        matches[name] = data.match != null ? data.match : (data.coverage != null ? data.coverage : null);
      } catch {
        matches[name] = null;
      }
    }

    var validMatches = Object.entries(matches).filter(function(entry) { return entry[1] != null; });
    if (validMatches.length < 2) return;

    var values = validMatches.map(function(entry) { return entry[1]; });
    var maxMatch = Math.max.apply(null, values);
    var minMatch = Math.min.apply(null, values);

    // Flag suspicious: any >90% but another <50%
    if (maxMatch > 90 && minMatch < 50) {
      var highMonitors = validMatches.filter(function(e) { return e[1] > 90; }).map(function(e) { return e[0]; });
      var lowMonitors = validMatches.filter(function(e) { return e[1] < 50; }).map(function(e) { return e[0]; });
      var warning = 'SUSPICIOUS: ' + highMonitors.join(',') + ' report >90% but ' + lowMonitors.join(',') + ' report <50%';
      this.log('error', 'cross_validation', warning);
      this.notify('Monitor Cross-Validation Warning', warning, 'monitor_warning');
    }

    // Verified match = minimum across all monitors
    var verifiedMatch = minMatch;

    // Write summary
    if (msId && msId !== '?') {
      var summaryDir = path.join(this.projectDir, '.team/' + this.groupLabel, msId, 'review');
      if (!fs.existsSync(summaryDir)) {
        fs.mkdirSync(summaryDir, { recursive: true });
      }
      var summary = {
        milestoneId: msId,
        timestamp: new Date().toISOString(),
        monitors: matches,
        verifiedMatch: verifiedMatch,
        suspicious: maxMatch > 90 && minMatch < 50
      };
      fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify(summary, null, 2));
      this.log('group_complete', msId, 'Cross-validation: verified match=' + verifiedMatch + '%');
    }
  }

  // --- Task 6: Auto Git Commit on Milestone Complete ---

  autoGitCommit(msId, msName) {
    // Check if there are critical gaps
    var gapsDir = path.join(this.projectDir, '.team/gaps');
    var hasCriticalGaps = false;
    var gapFiles = ['vision.json', 'prd.json', 'dbb.json', 'architecture.json'];
    for (var i = 0; i < gapFiles.length; i++) {
      try {
        var g = JSON.parse(fs.readFileSync(path.join(gapsDir, gapFiles[i]), 'utf8'));
        var matchVal = g.match != null ? g.match : (g.coverage != null ? g.coverage : 0);
        if (matchVal < 30) {
          hasCriticalGaps = true;
          break;
        }
      } catch {}
    }

    if (hasCriticalGaps) {
      this.log('error', msId, 'Skipping auto-commit: critical gaps detected (<30% match)');
      return;
    }

    try {
      execSync('git add -A && git tag -a ' + msId + '-complete -m "group ' + msId + ' complete: ' + msName + '"', {
        cwd: this.projectDir,
        stdio: 'pipe'
      });
      this.log('group_complete', msId, 'Auto git tag: ' + msId + '-complete');
    } catch (err) {
      this.log('error', msId, 'Auto git tag failed: ' + err.message);
    }
  }

  // --- Main Loop (safety interval) ---

  async run() {
    if (this.busy) {
      this.log('agent_start', 'daemon', 'Still busy, skipping safety check');
      return;
    }
    this.busy = true;

    try {
      var config = this.loadWorkflowConfig();
      var milestones = this.getMilestones();
      var active = this.getActiveMilestone();

      if (!milestones.milestones || milestones.milestones.length === 0) {
        await this.onProjectStart();
      } else if (this.isMilestoneComplete()) {
        await this.onMilestoneComplete();
      } else if (active) {
        const engine = new WorkflowEngine(config, this);
        await engine.executeNode('work_loop');
      } else {
        // All milestones completed, no active one
        this.log('agent_start', 'pm', 'All milestones completed, checking for new work...');
        await this.runAgent('pm');
        var newActive = this.getActiveMilestone();
        if (newActive) {
          const engine = new WorkflowEngine(config, this);
          await engine.executeNode('work_loop');
        }
      }
    } catch (err) {
      this.log('error', 'daemon', 'Error in main loop: ' + err.message);
    } finally {
      this.busy = false;
    }
  }

  // --- Start / Stop ---

  start() {
    if (this.running) return;
    
    // Check required files from config (if declared)
    var requiredFiles = (this.config && this.config.requiredFiles) || [];
    for (var i = 0; i < requiredFiles.length; i++) {
      var reqFile = requiredFiles[i];
      if (!fs.existsSync(path.join(this.projectDir, reqFile))) {
        console.error('\n❌ ERROR: ' + reqFile + ' not found in project directory');
        console.error('   Path: ' + this.projectDir);
        console.error('\nRequired files: ' + requiredFiles.join(', '));
        console.error('Please create the missing files before starting.\n');
        process.exit(1);
      }
    }
    
    this.running = true;
    this.log('agent_start', 'daemon', 'DevTeam daemon started (safety=' + (SAFETY_INTERVAL / 1000) + 's, timeout=' + (AGENT_TIMEOUT / 1000) + 's)');

    // Start health monitor (agent timeout, task loop, no progress, memory, etc.)
    this.healthMonitor = new DevTeamMonitor(this);
    this.healthMonitor.start();

    // Ensure .team directory exists
    var teamDir = path.join(this.projectDir, '.team');
    if (!fs.existsSync(teamDir)) {
      fs.mkdirSync(teamDir, { recursive: true });
    }

    // Write PID
    var pidPath = path.join(this.projectDir, '.team/daemon.pid');
    fs.writeFileSync(pidPath, process.pid.toString());

    // Start performance monitoring (every 5 minutes)
    this.perfMonitorInterval = setInterval(() => {
      const mem = process.memoryUsage();
      this.log('perf', 'daemon', JSON.stringify({
        rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
        uptime: Math.round(process.uptime()) + 's'
      }));
    }, 5 * 60 * 1000);

    // Immediate start
    this.run();

    // Safety interval: check every 10 minutes
    var self = this;
    this.timer = setInterval(function() {
      if (self.running) self.run();
    }, SAFETY_INTERVAL);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.healthMonitor) this.healthMonitor.stop();
    var pidPath = path.join(this.projectDir, '.team/daemon.pid');
    try { fs.unlinkSync(pidPath); } catch {}
    this.log('agent_complete', 'daemon', 'DevTeam daemon stopped');
  }
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// --- Entry Point ---

var projectDir = process.argv[2] || process.cwd();
var daemon = new TeamDaemon(projectDir, {});

// Process-level error protection
process.on('uncaughtException', function(err) {
  console.error('[' + ts() + '] Uncaught exception:', err.message);
  // Don't exit — keep running
});

process.on('unhandledRejection', function(err) {
  console.error('[' + ts() + '] Unhandled rejection:', err && err.message ? err.message : err);
  // Don't exit — keep running
});

// Export for testing
module.exports = TeamDaemon;

// Only start if run directly
if (require.main === module) {
  // Graceful shutdown
  process.on('SIGINT', function() { daemon.stop(); process.exit(0); });
  process.on('SIGTERM', function() { daemon.stop(); process.exit(0); });

  daemon.start();
}
