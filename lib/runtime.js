/**
 * Runtime — all "dirty work" that workflow steps need
 *
 * Three-layer architecture:
 *   daemon  → cron + process guard (when to run)
 *   engine  → workflow execution (what to run)
 *   runtime → capabilities (how to run)
 *
 * Runtime provides:
 *   - Agent execution (spawn Claude Code / runner.js)
 *   - Task & milestone management
 *   - Git operations
 *   - Notifications
 *   - CR system
 *   - Status tracking
 *   - Registered functions for workflow steps
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENT_TIMEOUT = 65 * 60 * 1000; // 65 min (runner has 60min, this is safety net)
const RUNNER = path.join(__dirname, '..', 'agents', 'runner.js');

const RuntimeInterface = require('./runtime-interface');
const EventBus = require('./event-bus');

class Runtime extends RuntimeInterface {
  constructor(projectDir, opts) {
    super();
    opts = opts || {};
    this.projectDir = projectDir;
    this.eventBus = new EventBus(projectDir);
    this.eventHandlers = {};
    this._failCounts = {};
    this._contextOverrides = null;
    this.config = null; // set by daemon before engine runs

    // Registered functions callable from workflow steps
    // Usage: { type: "function", fn: "markGroupComplete" }
    this.functions = {
      markGroupComplete: () => this._markGroupComplete(),
      crossValidateMonitors: () => this._crossValidateMonitors(),
      autoGitCommit: () => this._autoGitCommit(),
      generateReport: () => this._generateReport(),
      checkStuckExperiment: () => this._checkStuckExperiment(),
      checkStuckTasks: () => this.checkStuckTasks(),
      checkPendingCRs: () => this.checkPendingCRs(),
    };
  }

  // ─── Event System ───

  emit(event, data) {
    const handlers = this.eventHandlers[event] || [];
    handlers.forEach(handler => {
      try { handler(data); }
      catch (e) { this.log('error', 'event', `Handler error for ${event}: ${e.message}`); }
    });
  }

  on(event, handler) {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = [];
    this.eventHandlers[event].push(handler);
  }

  once(event, handler) {
    const wrapper = (data) => { handler(data); this.off(event, wrapper); };
    this.on(event, wrapper);
  }

  off(event, handler) {
    if (!this.eventHandlers[event]) return;
    this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
  }

  // ─── Logging ───

  log(event, agent, details) {
    var entry = {
      time: new Date().toISOString(),
      event, agent: agent || null, details: details || null
    };

    if (['agent_start', 'agent_complete', 'group_complete'].includes(event)) {
      var mem = process.memoryUsage();
      entry.performance = {
        memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
        memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        cpuUser: process.cpuUsage().user / 1000000,
        cpuSystem: process.cpuUsage().system / 1000000
      };
    }

    console.log('[' + ts() + '] [' + event + '] ' + (agent || '') + ' ' + (details || ''));
    this.eventBus.emit(event, agent, { details, performance: entry.performance });
  }

  // ─── Agent Execution ───

  runAgent(agentType) {
    var self = this;
    return new Promise(function(resolve) {
      var baseType = agentType.replace(/-\d+$/, '');
      var agentConfig = (self.config && self.config.agents && self.config.agents[baseType]) || {};
      var desc = agentConfig.description || baseType;

      self.log('agent_start', agentType, desc);
      self.updateAgentStatus(agentType, 'running', desc);

      var proc = spawn('node', [RUNNER, agentType, self.projectDir], {
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
        env: Object.assign({}, process.env, { CI: 'true' })
      });

      var timedOut = false;
      var timeout = setTimeout(function() {
        timedOut = true;
        try { process.kill(-proc.pid, 'SIGTERM'); } catch(e) {
          try { proc.kill('SIGTERM'); } catch(e2) {}
        }
      }, AGENT_TIMEOUT);

      // Liveness check: detect hung connections (0% CPU for 10+ min)
      var zeroCount = 0;
      var livenessCheck = setInterval(function() {
        try {
          // Find all descendant PIDs (runner → shell → claude)
          var pids = execSync(
            'pgrep -P ' + proc.pid + ' 2>/dev/null; pgrep -P $(pgrep -P ' + proc.pid + ' 2>/dev/null) 2>/dev/null; echo ' + proc.pid,
            { encoding: 'utf8', timeout: 3000 }
          ).trim().split('\n').filter(Boolean).join(',');
          var cpuStr = execSync(
            'ps -o pcpu= -p ' + pids + ' 2>/dev/null',
            { encoding: 'utf8', timeout: 3000 }
          ).trim();
          var totalCpu = cpuStr.split('\n').reduce(function(sum, line) {
            return sum + (parseFloat(line.trim()) || 0);
          }, 0);
          if (totalCpu < 0.1) {
            zeroCount++;
            if (zeroCount >= 5) { // 5 checks × 2min = 10min of 0% CPU
              self.log('error', agentType, 'hung (0% CPU for 10min across process tree), killing');
              timedOut = true;
              try { process.kill(-proc.pid, 'SIGKILL'); } catch(e) {
                try { proc.kill('SIGKILL'); } catch(e2) {}
              }
            }
          } else {
            zeroCount = 0;
          }
        } catch(e) { /* process already exited */ }
      }, 2 * 60 * 1000);

      proc.on('close', function(code) {
        clearTimeout(timeout);
        clearInterval(livenessCheck);

        if (timedOut) {
          self.updateAgentStatus(agentType, 'timeout', null);
          self.log('error', agentType, 'timed out after ' + (AGENT_TIMEOUT/1000) + 's, skipping');
          self.emit('agent_complete', { agent: agentType, success: false, timeout: true });
          resolve(false);
          return;
        }

        if (code === 0) {
          self.updateAgentStatus(agentType, 'idle', null);
          self.log('agent_complete', agentType, 'completed successfully');
          self._failCounts[baseType] = 0;

          // Read agent signal if available
          var signal = self.readAgentSignal(agentType);

          // Auto git commit from config
          var agentCfg = (self.config && self.config.agents && self.config.agents[baseType]) || {};
          var shouldCommit = agentCfg.gitCommit || (self.config && self.config.git && self.config.git.commitPerTask && agentCfg.scalable);
          if (shouldCommit) {
            try {
              var prefix = agentCfg.gitPrefix || baseType;
              execSync('git add -A && git diff --cached --quiet || git commit -m "' + prefix + ': ' + agentType + ' completed"', {
                cwd: self.projectDir, stdio: 'pipe'
              });
            } catch {}
          }

          self.emit('agent_complete', { agent: agentType, success: true, signal: signal });
          resolve(signal || true);
        } else {
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

          // Exponential backoff retry
          var maxRetries = (failAgentCfg && failAgentCfg.maxRetries) || 2;
          var statusPath = path.join(self.projectDir, '.team/agent-status.json');
          var all = {};
          try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
          var retryCount = (all[agentType] && all[agentType].retryCount) || 0;

          if (retryCount < maxRetries) {
            var delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s, 8s...
            self.log('error', agentType, 'failed (code=' + code + '), retry ' + (retryCount + 1) + '/' + maxRetries + ' in ' + (delay/1000) + 's');
            self.updateAgentStatus(agentType, 'retrying', null, retryCount + 1);

            // Write failure context so re-run agent knows what went wrong
            var signal = self.readAgentSignal(agentType);
            var failReason = (signal && signal.summary) ? signal.summary : ('exit code ' + code);
            var retryCtxPath = path.join(self.projectDir, '.team/retry-context.md');
            var retryCtx = '## Retry (attempt ' + (retryCount + 1) + ')\n\n' +
              'Your previous run failed:\n- ' + failReason + '\n\n' +
              'Please fix the issue and try again.\n';
            try { fs.writeFileSync(retryCtxPath, retryCtx); } catch {}

            setTimeout(function() {
              self.runAgent(agentType).then(resolve);
            }, delay);
          } else {
            self.updateAgentStatus(agentType, 'error', null, retryCount);
            self.log('error', agentType, 'failed (code=' + code + ') after ' + maxRetries + ' retries, giving up');
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

  readAgentSignal(agentType) {
    var signalPath = path.join(this.projectDir, '.team/signals', agentType + '.json');
    try {
      var signal = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
      this.log('workflow', agentType, '[SIGNAL] ' + signal.status + ': ' + (signal.summary || '').slice(0, 100));
      return signal;
    } catch { return null; }
  }

  updateAgentStatus(agentType, status, task, retryCount) {
    var statusPath = path.join(this.projectDir, '.team/agent-status.json');
    var all = {};
    try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    all[agentType] = {
      status,
      lastRun: new Date().toISOString(),
      currentTask: task || null,
      retryCount: retryCount != null ? retryCount : (all[agentType] && all[agentType].retryCount) || 0
    };
    fs.writeFileSync(statusPath, JSON.stringify(all, null, 2));
  }

  // ─── Notifications ───

  async notify(title, message, event) {
    var config = this.config || {};
    var notifyConfig = config.notify || {};

    if (notifyConfig.openclaw && notifyConfig.openclaw.sessionKey) {
      try {
        var sessionKey = notifyConfig.openclaw.sessionKey;
        var notifyMsg = '[DevTeam: ' + title + '] ' + message;
        execSync('openclaw sessions send --session "' + sessionKey + '" "' + notifyMsg.replace(/"/g, '\\"') + '"', { timeout: 5000 });
      } catch {}
    }

    if (notifyConfig.webhooks && Array.isArray(notifyConfig.webhooks)) {
      var projectConfig = {};
      try { projectConfig = JSON.parse(fs.readFileSync(path.join(this.projectDir, '.team/config.json'), 'utf8')); } catch {}
      var projectName = (projectConfig && projectConfig.name) || path.basename(this.projectDir);

      for (var i = 0; i < notifyConfig.webhooks.length; i++) {
        var hook = notifyConfig.webhooks[i];
        if (!hook.url) continue;
        var events = hook.events || ['*'];
        if (events.indexOf('*') === -1 && event && events.indexOf(event) === -1) continue;

        var payload = {
          project: projectName, title, message,
          event: event || 'notification',
          timestamp: new Date().toISOString()
        };

        try {
          var https = require('https');
          var http = require('http');
          var urlMod = require('url');
          var parsed = urlMod.parse(hook.url);
          var client = parsed.protocol === 'https:' ? https : http;
          var postData = JSON.stringify(payload);

          var req = client.request({
            hostname: parsed.hostname, port: parsed.port, path: parsed.path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
          }, function() {});
          req.on('error', function() {});
          req.write(postData);
          req.end();
        } catch {}
      }
    }

    if (notifyConfig.macos) {
      try {
        execSync('osascript -e \'display notification "' + message + '" with title "DevTeam: ' + title + '"\'');
      } catch {}
    }
  }

  // ─── Group / Milestone Management ───

  get groupLabel() {
    var cfg = this.config || {};
    return (cfg.groups && cfg.groups.label) || 'milestones';
  }

  getGroups() {
    var label = this.groupLabel;
    var p = path.join(this.projectDir, '.team', label, label + '.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return { groups: [] }; }
  }

  getActiveGroup() {
    var data = this.getGroups();
    return (data.groups || data.milestones || []).find(m =>
      m.status === 'active' || m.status === 'ready-for-work' || m.status === 'in-progress'
    ) || null;
  }

  isGroupComplete() {
    var ms = this.getActiveGroup();
    if (!ms || !ms.tasks || ms.tasks.length === 0) return false;
    var kanban = this.getKanban();
    var doneSet = new Set(kanban.done || []);
    return ms.tasks.every(id => doneSet.has(id));
  }

  _markGroupComplete() {
    var ms = this.getActiveGroup();
    if (!ms) return;

    var label = this.groupLabel;
    var msId = ms.id;
    var msName = ms.name;

    this.log('group_complete', msId, '=== ' + label.toUpperCase() + ' ' + msId + ' COMPLETE: ' + msName + ' ===');

    // Mark milestone status
    var data = this.getGroups();
    var target = (data.groups || data.milestones || []).find(m => m.id === msId);
    if (target) {
      target.status = 'completed';
      target.completedAt = new Date().toISOString();
      var p = path.join(this.projectDir, '.team', label, label + '.json');
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    }

    // Ensure review directory
    var reviewDir = path.join(this.projectDir, '.team', label, msId, 'review');
    if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });

    this.notify(label + '完成: ' + msName, msName + ' 已完成', 'group_complete');
  }

  // ─── Data Reading ───

  getKanban() {
    var TaskManager = require('./task-manager');
    var tm = new TaskManager(this.projectDir, this);
    return tm.getKanban();
  }

  // ─── Stuck Task Detection ───

  checkStuckTasks() {
    var kanban = this.getKanban();
    var inProgress = kanban.inProgress || [];
    if (inProgress.length === 0) return;

    var statusPath = path.join(this.projectDir, '.team/agent-status.json');
    var agentStatus = {};
    try { agentStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}

    var anyRunning = Object.values(agentStatus).some(a => a.status === 'running');
    if (anyRunning) return;

    var TaskManager = require('./task-manager');
    var tm = new TaskManager(this.projectDir, this);
    var now = Date.now();
    var TWO_HOURS = 2 * 60 * 60 * 1000;

    for (var i = 0; i < inProgress.length; i++) {
      var taskId = inProgress[i];
      try {
        var task = tm.getTask(taskId);
        if (!task) continue;
        var updated = new Date(task.updated).getTime();
        if (now - updated > TWO_HOURS) {
          tm.updateTask(taskId, { status: 'todo', assignee: null });
          this.log('error', taskId, 'Task timeout (>2h), moved back to todo');
        }
      } catch {}
    }
  }

  // ─── CR System ───

  getCRHierarchy() {
    return (this.config && this.config.cr && this.config.cr.hierarchy) ||
      ['pm', 'architect', 'tech_lead', 'developer', 'tester'];
  }

  getUpstream(role) {
    const hierarchy = this.getCRHierarchy();
    const idx = hierarchy.indexOf(role);
    if (idx <= 0) return null;
    return hierarchy[idx - 1];
  }

  submitCR(cr) {
    const missing = [];
    if (!cr.evidence) missing.push('evidence');
    if (!cr.impact) missing.push('impact');
    if (!cr.proposal) missing.push('proposal');
    if (!cr.from) missing.push('from');
    if (missing.length > 0) {
      this.log('cr', cr.from || 'unknown', `[CR-REJECTED] Missing: ${missing.join(', ')}`);
      return { accepted: false, reason: `Missing: ${missing.join(', ')}` };
    }

    const upstream = cr.to || this.getUpstream(cr.from);
    if (!upstream) {
      this.log('cr', cr.from, `[CR-REJECTED] ${cr.from} at top of hierarchy`);
      return { accepted: false, reason: `${cr.from} has no upstream` };
    }

    const hierarchy = this.getCRHierarchy();
    const fromIdx = hierarchy.indexOf(cr.from);
    const toIdx = hierarchy.indexOf(upstream);
    if (fromIdx - toIdx !== 1) {
      this.log('cr', cr.from, `[CR-REJECTED] ${cr.from} → ${upstream}: must escalate to direct upstream`);
      return { accepted: false, reason: `Cannot skip levels` };
    }

    const crId = 'cr-' + Date.now();
    const crData = {
      id: crId, from: cr.from, to: upstream,
      evidence: cr.evidence, impact: cr.impact, proposal: cr.proposal,
      severity: cr.severity || 'normal', status: 'pending',
      created: new Date().toISOString()
    };

    const crDir = path.join(this.projectDir, '.team/change-requests');
    fs.mkdirSync(crDir, { recursive: true });
    fs.writeFileSync(path.join(crDir, crId + '.json'), JSON.stringify(crData, null, 2));
    this.log('cr', cr.from, `[CR] ${crId}: ${cr.from} → ${upstream} | ${cr.impact}`);
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
      this.log('cr', cr.to, `[CR-ACCEPTED] ${crId}`);
      this.emit('cr_accepted', cr);
    } else if (decision === 'escalate') {
      const nextUp = this.getUpstream(cr.to);
      if (!nextUp) {
        cr.status = 'rejected';
        cr.resolution = 'Top of hierarchy';
        cr.reviewedAt = new Date().toISOString();
        fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
        this.log('cr', cr.to, `[CR-CEILING] ${crId}`);
      } else {
        cr.to = nextUp;
        cr.escalatedAt = new Date().toISOString();
        fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
        this.log('cr', cr.to, `[CR-ESCALATED] ${crId} → ${nextUp}`);
        this.emit('cr_escalated', cr);
      }
    } else if (decision === 'reject') {
      cr.status = 'rejected';
      cr.resolution = resolution || 'Rejected';
      cr.reviewedAt = new Date().toISOString();
      fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
      this.log('cr', cr.to, `[CR-REJECTED] ${crId}`);
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
        if (Date.now() - new Date(cr.created).getTime() > staleMs) {
          cr.status = 'stale';
          cr.resolution = `Auto-staled after ${staleHours}h`;
          fs.writeFileSync(path.join(crDir, f), JSON.stringify(cr, null, 2));
          this.log('cr', cr.to, `[CR-STALE] ${cr.id}`);
        }
      } catch {}
    }
    if (pendingCount > 10) {
      this.log('cr', 'system', `[CR-ANOMALY] ${pendingCount} pending CRs`);
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

  // ─── CR File Operations ───

  /**
   * Update a CR file's status.
   * @param {string} filename - CR json filename (e.g. 'cr-12345.json')
   * @param {object} updates - fields to merge (status, reviewedAt, etc.)
   */
  updateCRFile(filename, updates) {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    var crPath = path.join(crDir, filename);
    if (!fs.existsSync(crPath)) return null;
    var cr = JSON.parse(fs.readFileSync(crPath, 'utf8'));
    Object.assign(cr, updates);
    fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
    return cr;
  }

  // ─── Task File Operations ───

  /**
   * Update a task's fields by task directory name.
   * @param {string} taskDir - task directory name (relative to .team/tasks/)
   * @param {object} updates - fields to merge (status, assignee, etc.)
   */
  updateTaskFields(taskDir, updates) {
    var taskPath = path.join(this.projectDir, '.team/tasks', taskDir, 'task.json');
    if (!fs.existsSync(taskPath)) return null;
    var task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    Object.assign(task, updates);
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
    return task;
  }

  /**
   * Read a task by directory name.
   */
  readTask(taskDir) {
    var taskPath = path.join(this.projectDir, '.team/tasks', taskDir, 'task.json');
    if (!fs.existsSync(taskPath)) return null;
    return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  }

  /**
   * List task directories that have a task.json.
   */
  listTaskDirs() {
    var tasksDir = path.join(this.projectDir, '.team/tasks');
    if (!fs.existsSync(tasksDir)) return [];
    return fs.readdirSync(tasksDir).filter(d =>
      fs.existsSync(path.join(tasksDir, d, 'task.json'))
    );
  }

  /**
   * Check if a file exists relative to a task directory.
   */
  taskFileExists(taskDir, filename) {
    return fs.existsSync(path.join(this.projectDir, '.team/tasks', taskDir, filename));
  }

  /**
   * Read a file from a task directory.
   */
  readTaskFile(taskDir, filename) {
    var p = path.join(this.projectDir, '.team/tasks', taskDir, filename);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  }

  /**
   * List CR files.
   */
  listCRFiles() {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return [];
    try { return fs.readdirSync(crDir).filter(f => f.endsWith('.json')); }
    catch { return []; }
  }

  /**
   * Read a CR file.
   */
  readCRFile(filename) {
    var crPath = path.join(this.projectDir, '.team/change-requests', filename);
    if (!fs.existsSync(crPath)) return null;
    return JSON.parse(fs.readFileSync(crPath, 'utf8'));
  }

  /**
   * Read a gap analysis file.
   */
  readGap(name) {
    var p = path.join(this.projectDir, '.team/gaps', name + '.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  /**
   * Check if a file exists relative to projectDir.
   */
  fileExists(relativePath) {
    return fs.existsSync(path.join(this.projectDir, relativePath));
  }

  // ─── Cross-Validation ───

  _crossValidateMonitors() {
    var ms = this.getActiveGroup();
    var msId = ms ? ms.id : null;

    var gapsDir = path.join(this.projectDir, '.team/gaps');
    var monitors = ['vision', 'prd', 'dbb', 'architecture'];
    var matches = {};

    for (var name of monitors) {
      try {
        var data = JSON.parse(fs.readFileSync(path.join(gapsDir, name + '.json'), 'utf8'));
        matches[name] = data.match != null ? data.match : (data.coverage != null ? data.coverage : null);
      } catch { matches[name] = null; }
    }

    var validMatches = Object.entries(matches).filter(e => e[1] != null);
    if (validMatches.length < 2) return;

    var values = validMatches.map(e => e[1]);
    var maxMatch = Math.max(...values);
    var minMatch = Math.min(...values);

    if (maxMatch > 90 && minMatch < 50) {
      var high = validMatches.filter(e => e[1] > 90).map(e => e[0]);
      var low = validMatches.filter(e => e[1] < 50).map(e => e[0]);
      var warning = 'SUSPICIOUS: ' + high.join(',') + ' >90% but ' + low.join(',') + ' <50%';
      this.log('error', 'cross_validation', warning);
      this.notify('Monitor Cross-Validation Warning', warning, 'monitor_warning');
    }

    if (msId) {
      var reviewDir = path.join(this.projectDir, '.team/' + this.groupLabel, msId, 'review');
      if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });
      var summary = {
        groupId: msId, timestamp: new Date().toISOString(),
        monitors: matches, verifiedMatch: minMatch,
        suspicious: maxMatch > 90 && minMatch < 50
      };
      fs.writeFileSync(path.join(reviewDir, 'summary.json'), JSON.stringify(summary, null, 2));
      this.log('group_complete', msId, 'Cross-validation: verified match=' + minMatch + '%');
    }
  }

  // ─── Stuck Experiment Detection ───

  _checkStuckExperiment() {
    var logPath = path.join(this.projectDir, 'experiments.log');
    if (!fs.existsSync(logPath)) return;

    var lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    var decisions = [];
    for (var line of lines) {
      try {
        var entry = JSON.parse(line);
        if (entry.decision) decisions.push(entry);
      } catch {}
    }

    // Count consecutive reverts from the end
    var consecutiveReverts = 0;
    for (var i = decisions.length - 1; i >= 0; i--) {
      if (decisions[i].decision === 'revert') consecutiveReverts++;
      else break;
    }

    // Write stuck signal for scientist to read
    var stuckPath = path.join(this.projectDir, '.team', 'stuck-signal.json');
    var signal = {
      consecutiveReverts,
      totalExperiments: decisions.length,
      keepCount: decisions.filter(d => d.decision === 'keep').length,
      revertCount: decisions.filter(d => d.decision === 'revert').length,
      blockedCount: decisions.filter(d => d.decision === 'blocked').length,
      escalation: 'none',
      message: ''
    };

    if (consecutiveReverts >= 5) {
      signal.escalation = 'data';
      signal.message = '连续 ' + consecutiveReverts + ' 次 revert。参数和算法调优已穷尽。必须从数据层面解决：往图谱里添加缺失的节点/边/evidence，或修改 test case 的期望。如果问题本身不可解（如图谱中确实没有相关知识），应该标记 goalMet=1 并在 analyze 中记录结论。';
    } else if (consecutiveReverts >= 3) {
      signal.escalation = 'structure';
      signal.message = '连续 ' + consecutiveReverts + ' 次 revert。单参数调优可能已到天花板。考虑算法级改动：新的排序策略、新的搜索路径、新的特征维度。不要再微调同一个参数。';
    }

    fs.writeFileSync(stuckPath, JSON.stringify(signal, null, 2));

    if (signal.escalation !== 'none') {
      this.log('workflow', 'stuck-check', '[STUCK] ' + signal.escalation + ': ' + consecutiveReverts + ' consecutive reverts');
    }

    // Write to context overrides so when expressions can use it
    if (!this._contextOverrides) this._contextOverrides = {};
    this._contextOverrides.consecutiveReverts = consecutiveReverts;
  }

  // ─── Report Generation ───

  _generateReport() {
    var config = this.config || {};
    var projectName = '';
    try {
      var pc = JSON.parse(fs.readFileSync(path.join(this.projectDir, '.team/config.json'), 'utf8'));
      projectName = pc.name || path.basename(this.projectDir);
    } catch { projectName = path.basename(this.projectDir); }

    var lines = [];
    lines.push('# DevTeam Report — ' + projectName);
    lines.push('');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('');

    // Goal
    if (config.goal) {
      lines.push('## Goal');
      lines.push(config.goal.description || '(no description)');
      lines.push('');
    }

    // Match
    lines.push('## Match');
    var gapsDir = path.join(this.projectDir, '.team/gaps');
    for (var name of ['vision', 'prd', 'dbb', 'architecture']) {
      try {
        var g = JSON.parse(fs.readFileSync(path.join(gapsDir, name + '.json'), 'utf8'));
        var match = g.match != null ? g.match : (g.coverage != null ? g.coverage : '?');
        lines.push('- ' + name + ': ' + match + '%');
      } catch { lines.push('- ' + name + ': ?'); }
    }
    lines.push('');

    // Groups
    lines.push('## Groups');
    var data = this.getGroups();
    var groups = data.groups || data.milestones || [];
    for (var g of groups) {
      var icon = g.status === 'completed' ? '✅' : g.status === 'active' ? '🔵' : '⚪';
      lines.push(icon + ' **' + g.id + '** ' + g.name + ' [' + g.status + ']');
      if (g.tasks) lines.push('  Tasks: ' + g.tasks.length);
    }
    lines.push('');

    // Tasks summary
    lines.push('## Tasks');
    var kanban = this.getKanban();
    var total = 0;
    for (var status of ['todo', 'inProgress', 'review', 'testing', 'done', 'blocked']) {
      var count = (kanban[status] || []).length;
      total += count;
      if (count > 0) lines.push('- ' + status + ': ' + count);
    }
    var doneCount = (kanban.done || []).length;
    lines.push('- **Total: ' + total + ', ' + (total > 0 ? Math.round(doneCount / total * 100) : 0) + '% complete**');
    lines.push('');

    // Git stats
    try {
      var gitLog = require('child_process').execSync(
        'git log --oneline --since="1 week ago" | wc -l',
        { cwd: this.projectDir, encoding: 'utf8', timeout: 5000 }
      ).trim();
      lines.push('## Git');
      lines.push('- Commits (last week): ' + gitLog);
      var lastTag = require('child_process').execSync(
        'git tag --sort=-creatordate | head -1',
        { cwd: this.projectDir, encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (lastTag) lines.push('- Latest tag: ' + lastTag);
    } catch {}
    lines.push('');

    // Write
    var reportPath = path.join(this.projectDir, 'REPORT.md');
    fs.writeFileSync(reportPath, lines.join('\n'));
    this.log('workflow', 'report', 'Generated REPORT.md (' + lines.length + ' lines)');
  }

  // ─── Auto Git ───

  _autoGitCommit() {
    var ms = this.getActiveGroup();
    if (!ms) return;
    var msId = ms.id;
    var msName = ms.name;

    var gapsDir = path.join(this.projectDir, '.team/gaps');
    var gapFiles = ['vision.json', 'prd.json', 'dbb.json', 'architecture.json'];
    for (var gf of gapFiles) {
      try {
        var g = JSON.parse(fs.readFileSync(path.join(gapsDir, gf), 'utf8'));
        var matchVal = g.match != null ? g.match : (g.coverage != null ? g.coverage : 0);
        if (matchVal < 30) {
          this.log('error', msId, 'Skipping auto-commit: critical gaps (<30%)');
          return;
        }
      } catch {}
    }

    try {
      execSync('git add -A && git tag -a ' + msId + '-complete -m "group ' + msId + ' complete: ' + msName + '"', {
        cwd: this.projectDir, stdio: 'pipe'
      });
      this.log('group_complete', msId, 'Auto git tag: ' + msId + '-complete');
    } catch (err) {
      this.log('error', msId, 'Auto git tag failed: ' + err.message);
    }
  }

  // ─── Process Management (used by daemon) ───

  killOrphanAgents() {
    try {
      var result = execSync(
        'pgrep -f "runner.js ' + this.projectDir + '" 2>/dev/null || true',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (result) {
        var pids = result.split('\n').filter(Boolean);
        for (var pid of pids) {
          try {
            process.kill(-parseInt(pid), 'SIGTERM');
            this.log('workflow', 'daemon', 'Killed orphan process group: ' + pid);
          } catch(e) {
            try { process.kill(parseInt(pid), 'SIGTERM'); } catch(e2) {}
          }
        }
      }
    } catch(e) {
      this.log('error', 'daemon', 'Orphan cleanup error: ' + e.message);
    }
  }

  resetStuckAgents() {
    var statusPath = path.join(this.projectDir, '.team/agent-status.json');
    try {
      var all = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      var reset = false;
      for (var key in all) {
        if (all[key].status === 'running') {
          this.log('workflow', 'daemon', 'Reset stuck agent: ' + key);
          all[key].status = 'idle';
          all[key].currentTask = null;
          reset = true;
        }
      }
      if (reset) fs.writeFileSync(statusPath, JSON.stringify(all, null, 2));
    } catch(e) {}
  }

  // ─── Function Execution (for workflow steps) ───

  executeFunction(fnName, args) {
    var fn = this.functions[fnName];
    if (!fn) {
      this.log('error', 'runtime', 'Unknown function: ' + fnName);
      return;
    }
    return fn(args);
  }
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = Runtime;
