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
const WorkflowEngine = require('./workflow-engine-v3');

const SAFETY_INTERVAL = 10 * 60 * 1000; // 10 min
const AGENT_TIMEOUT = 60 * 60 * 1000;   // 60 min
const RUNNER = path.join(__dirname, 'runner.js');
const DEVTEAM_ROOT = path.join(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(DEVTEAM_ROOT, 'configs/dev-team.json');

class TeamDaemon {
  constructor(projectDir, opts) {
    opts = opts || {};
    this.projectDir = projectDir;
    this.running = false;
    this.busy = false;
    this.maxDevs = opts.devs || 3;
    this.workLoopCount = 0;
    this.perfMonitorInterval = null;
    this.techLeadFailCount = 0; // 修复 4: tech_lead 失败计数
    this.architectFailCount = 0; // 修复 5: architect 失败计数
    
    // Event system
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

  evaluateCondition(condition) {
    if (!condition) return true;

    if (condition === 'no-architecture') {
      var archPath = path.join(this.projectDir, 'ARCHITECTURE.md');
      if (!fs.existsSync(archPath)) return true;
      return fs.readFileSync(archPath, 'utf8').trim().length < 100;
    }

    // Unknown condition — run by default
    return true;
  }

  // --- Structured Logging (Task 7) ---

  log(event, agent, details) {
    var entry = {
      time: new Date().toISOString(),
      event: event,
      agent: agent || null,
      details: details || null
    };

    // Task 4: Add performance metrics
    if (event === 'agent_start' || event === 'agent_complete' || event === 'milestone_complete') {
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

    // Append to daemon.log (JSONL format)
    var logPath = path.join(this.projectDir, '.team/daemon.log');
    try {
      var teamDir = path.join(this.projectDir, '.team');
      if (!fs.existsSync(teamDir)) {
        fs.mkdirSync(teamDir, { recursive: true });
      }
      // Append as single line JSON
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch (e) {
      // Ignore write errors
    }
  }

  // --- Agent Execution ---

  runAgent(agentType) {
    var self = this;
    return new Promise(function(resolve) {
      var baseType = agentType.replace(/-\d+$/, '');
      var taskDesc = {
        architect: '设计系统架构',
        vision_monitor: '评估愿景匹配度',
        prd_monitor: '评估PRD匹配度',
        dbb_monitor: '评估DBB匹配度',
        arch_monitor: '评估架构匹配度',
        pm: '管理任务和里程碑',
        tech_lead: '出技术方案',
        developer: '实现功能',
        tester: '验证功能'
      };

      self.log('agent_start', agentType, taskDesc[baseType] || agentType);
      self.updateAgentStatus(agentType, 'running', taskDesc[baseType] || agentType);

      // 修复 6: PM 运行前备份 kanban
      if (baseType === 'pm') {
        self.backupKanban();
      }

      var proc = spawn('node', [RUNNER, agentType, self.projectDir], {
        stdio: ['ignore', 'inherit', 'inherit'] // no stdin (nohup-compatible)
      });

      var timeout = setTimeout(function() {
        proc.kill('SIGTERM');
      }, AGENT_TIMEOUT);

      proc.on('close', function(code) {
        clearTimeout(timeout);
        if (code === 0) {
          self.updateAgentStatus(agentType, 'idle', null);
          self.log('agent_complete', agentType, 'completed successfully');

          // 修复 4: tech_lead 成功后重置计数
          if (baseType === 'tech_lead') {
            self.techLeadFailCount = 0;
          }
          // 修复 5: architect 成功后重置计数
          if (baseType === 'architect') {
            self.architectFailCount = 0;
          }

          // PM 完成后发送 kanban_updated 事件
          if (baseType === 'pm') {
            var kanbanPath = path.join(self.projectDir, '.team/kanban.json');
            try {
              var kanban = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
              self.emit('kanban_updated', kanban);
            } catch (e) {
              self.log('error', 'pm', 'Failed to read kanban: ' + e.message);
            }
          }

          // Auto git commit after developer or tester completes (from config)
          var config = self.loadWorkflowConfig();
          if (config.git && config.git.commitPerTask && (baseType === 'developer' || baseType === 'tester')) {
            try {
              var prefix = baseType === 'developer' ? 'feat' : 'test';
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
          // 修复 4: tech_lead 连续失败 3 次后创建最小化 design.md
          if (baseType === 'tech_lead') {
            self.techLeadFailCount++;
            if (self.techLeadFailCount >= 3) {
              self.log('error', 'tech_lead', 'Failed 3 times, creating minimal design.md template');
              self.createMinimalDesign();
              self.techLeadFailCount = 0;
              resolve(true);
              return;
            }
          }

          // 修复 5: architect 连续失败 3 次后创建最小化 ARCHITECTURE.md
          if (baseType === 'architect') {
            self.architectFailCount++;
            if (self.architectFailCount >= 3) {
              self.log('error', 'architect', 'Failed 3 times, creating minimal ARCHITECTURE.md template');
              self.createMinimalArchitecture();
              self.architectFailCount = 0;
              resolve(true);
              return;
            }
            
            // 修复 7: architect 失败后恢复 CR 为 pending
            self.restorePendingCRs();
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
            
            // 修复 6: PM 失败后恢复 kanban
            if (baseType === 'pm') {
              self.restoreKanban();
            }
            
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

  checkPendingCRs() {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return;

    var files;
    try { files = fs.readdirSync(crDir).filter(function(f) { return f.endsWith('.json'); }); } catch { return; }

    // CR 趋势监控：检测异常增长
    var pendingCount = 0;
    var totalCount = files.length;
    
    var blockerCRs = [];
    var architectureIssues = [];
    
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        var cr = JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8'));
        if (cr.status === 'pending') {
          pendingCount++;
          
          // Check if this is an architecture issue (should trigger architect, not CR)
          // 修复 3: 增加上下文判断 - affectedTasks ≥3 且不是 architect 发起的
          var isArchIssue = (cr.affectedTasks && cr.affectedTasks.length >= 3 && cr.from !== 'architect') ||
            (cr.reason && (
              cr.reason.toLowerCase().includes('architecture') ||
              cr.reason.toLowerCase().includes('架构') ||
              cr.reason.toLowerCase().includes('missing component') ||
              cr.reason.toLowerCase().includes('design flaw')
            ));
          
          if (isArchIssue) {
            architectureIssues.push(cr);
            this.log('error', cr.id, 'Architecture issue detected, should trigger architect instead of CR');
            // Auto-resolve this CR and trigger architect
            cr.status = 'resolved';
            cr.resolution = 'Converted to architect task';
            fs.writeFileSync(path.join(crDir, f), JSON.stringify(cr, null, 2));
            continue;
          }
          
          this.log('cr_created', cr.from || 'unknown', 'CR ' + (cr.id || f) + ': ' + (cr.reason || 'no reason'));
          this.notify('Change Request', '[' + cr.from + '] ' + (cr.reason || 'New CR pending'), 'cr_created');
          
          // Task 2: Detect blocker CRs (affecting multiple tasks)
          if (cr.isBlocker || (cr.affectedTasks && cr.affectedTasks.length >= 2)) {
            blockerCRs.push(cr);
            
            // 修复 8: 超过 48 小时自动降级为普通 CR
            var created = new Date(cr.created).getTime();
            var now = Date.now();
            var elapsed = now - created;
            var FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
            
            if (elapsed > FORTY_EIGHT_HOURS) {
              this.log('error', cr.id, 'BLOCKER CR timeout (>48h), downgrading to normal CR');
              cr.isBlocker = false;
              fs.writeFileSync(path.join(crDir, f), JSON.stringify(cr, null, 2));
              
              // Unblock affected tasks
              var TaskManager = require(path.join(__dirname, '../lib/task-manager.js'));
              var tm = new TaskManager(this.projectDir);
              if (cr.affectedTasks) {
                for (var j = 0; j < cr.affectedTasks.length; j++) {
                  var taskId = cr.affectedTasks[j];
                  try {
                    var task = tm.getTask(taskId);
                    if (task && task.status === 'blocked') {
                      var newBlockedBy = (task.blockedBy || []).filter(function(id) { return id !== cr.id; });
                      if (newBlockedBy.length === 0) {
                        tm.updateTask(taskId, { status: 'todo', blockedBy: newBlockedBy });
                      } else {
                        tm.updateTask(taskId, { blockedBy: newBlockedBy });
                      }
                    }
                  } catch {}
                }
              }
            } else {
              this.log('error', cr.id, 'BLOCKER CR: affects ' + (cr.affectedTasks ? cr.affectedTasks.length : 0) + ' tasks');
            }
          }
        }
      } catch {}
    }

    // CR 异常检测：pending CR 过多
    if (pendingCount > 20) {
      this.log('error', 'cr_anomaly', 'CR 异常增长: ' + pendingCount + ' pending CRs (total: ' + totalCount + ')');
      this.notify('CR Anomaly Detected', pendingCount + ' pending CRs detected - possible duplicate submissions', 'cr_anomaly');
    }

    // 修复 5: 真正触发 architect（不只是通知）
    if (architectureIssues.length > 0) {
      this.log('agent_start', 'architect', 'Triggering architect for ' + architectureIssues.length + ' architecture issue(s)');
      this.notify('Architecture Issues Detected', architectureIssues.length + ' issue(s) need architect review', 'architecture_issue');
      // 立即触发 architect
      var self = this;
      this.runAgent('architect').catch(function(err) {
        self.log('error', 'architect', 'Failed to run architect: ' + err.message);
      });
    }

    // Task 2: Notify about blocker CRs
    if (blockerCRs.length > 0) {
      var blockerMsg = blockerCRs.length + ' blocker CR(s) detected, ' + 
        blockerCRs.map(function(cr) { return cr.id; }).join(', ');
      this.notify('Blocker CRs Detected', blockerMsg, 'blocker_cr');
    }

    // Emit cr_changed event if there are pending CRs or architecture issues
    if (pendingCount > 0 || architectureIssues.length > 0) {
      this.emit('cr_changed', { 
        pendingCount: pendingCount, 
        totalCount: totalCount,
        blockerCount: blockerCRs.length,
        architectureIssues: architectureIssues.length
      });
    }
  }

  // 修复 1: 检查是否有 pending blocker CR
  hasBlockerCR() {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return false;

    var files;
    try { files = fs.readdirSync(crDir).filter(function(f) { return f.endsWith('.json'); }); } catch { return false; }

    for (var i = 0; i < files.length; i++) {
      try {
        var cr = JSON.parse(fs.readFileSync(path.join(crDir, files[i]), 'utf8'));
        if (cr.status === 'pending' && cr.isBlocker) {
          return true;
        }
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

    // 修复 3: 超时检测（>2小时强制标记 timeout）
    var TaskManager = require(path.join(__dirname, '../lib/task-manager.js'));
    var tm = new TaskManager(this.projectDir);
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

    // If we've done 2+ work loops with same inProgress tasks, move them back to todo
    if (this.workLoopCount >= 2 && inProgress.length > 0) {
      for (var i = 0; i < inProgress.length; i++) {
        var taskId = inProgress[i];
        try {
          tm.updateTask(taskId, { status: 'todo', assignee: null });
          this.log('error', taskId, 'Task stuck in inProgress for 2+ loops, moved back to todo');
        } catch {}
      }
      this.workLoopCount = 0;
    }
  }

  // --- Data Reading ---

  getKanban() {
    var p = path.join(this.projectDir, '.team/kanban.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
    }
  }

  getMilestones() {
    var p = path.join(this.projectDir, '.team/milestones/milestones.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { milestones: [] };
    }
  }

  getActiveMilestone() {
    var data = this.getMilestones();
    return (data.milestones || []).find(function(m) { return m.status === 'active'; }) || null;
  }

  // 修复 4: 创建最小化 design.md 模板
  createMinimalDesign() {
    var ms = this.getActiveMilestone();
    if (!ms) return;

    var designPath = path.join(this.projectDir, '.team/milestones', ms.id, 'design.md');
    var template = '# ' + ms.name + ' - Technical Design\n\n' +
      '## Architecture\n\n' +
      '## Implementation Plan\n\n' +
      '## Dependencies\n\n';

    try {
      fs.writeFileSync(designPath, template);
      this.log('info', 'tech_lead', 'Created minimal design.md template at ' + designPath);
    } catch (err) {
      this.log('error', 'tech_lead', 'Failed to create design.md: ' + err.message);
    }
  }

  // 修复 5: 创建最小化 ARCHITECTURE.md 模板
  createMinimalArchitecture() {
    var archPath = path.join(this.projectDir, 'ARCHITECTURE.md');
    var template = '# Architecture\n\n' +
      '## System Overview\n\n' +
      '## Components\n\n' +
      '## Data Flow\n\n';

    try {
      fs.writeFileSync(archPath, template);
      this.log('info', 'architect', 'Created minimal ARCHITECTURE.md template at ' + archPath);
    } catch (err) {
      this.log('error', 'architect', 'Failed to create ARCHITECTURE.md: ' + err.message);
    }
  }

  // 修复 6: PM 崩溃时回退 kanban
  backupKanban() {
    var kanbanPath = path.join(this.projectDir, '.team/kanban.json');
    var backupPath = path.join(this.projectDir, '.team/kanban.backup.json');
    try {
      if (fs.existsSync(kanbanPath)) {
        fs.copyFileSync(kanbanPath, backupPath);
      }
    } catch (err) {
      this.log('error', 'pm', 'Failed to backup kanban: ' + err.message);
    }
  }

  restoreKanban() {
    var kanbanPath = path.join(this.projectDir, '.team/kanban.json');
    var backupPath = path.join(this.projectDir, '.team/kanban.backup.json');
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, kanbanPath);
        this.log('info', 'pm', 'Restored kanban from backup');
      }
    } catch (err) {
      this.log('error', 'pm', 'Failed to restore kanban: ' + err.message);
    }
  }

  // 修复 7: architect 失败后恢复 CR 为 pending
  restorePendingCRs() {
    var crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return;

    try {
      var files = fs.readdirSync(crDir).filter(function(f) { return f.endsWith('.json'); });
      for (var i = 0; i < files.length; i++) {
        var crPath = path.join(crDir, files[i]);
        var cr = JSON.parse(fs.readFileSync(crPath, 'utf8'));
        
        // 恢复被标记为 "Converted to architect task" 的 CR
        if (cr.status === 'resolved' && cr.resolution === 'Converted to architect task') {
          cr.status = 'pending';
          delete cr.resolution;
          fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
          this.log('info', 'architect', 'Restored CR ' + cr.id + ' to pending');
        }
      }
    } catch (err) {
      this.log('error', 'architect', 'Failed to restore CRs: ' + err.message);
    }
  }

  getTasksWithDesign() {
    var kanban = this.getKanban();
    var todoIds = kanban.todo || [];
    var count = 0;
    for (var i = 0; i < todoIds.length; i++) {
      var tid = todoIds[i];
      var taskPath = path.join(this.projectDir, '.team/tasks', tid, 'task.json');
      try {
        var task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        if (task.hasDesign) count++;
      } catch {}
    }
    return count;
  }

  getReviewCount() {
    var kanban = this.getKanban();
    return (kanban.review || []).length;
  }

  getDoneCount() {
    var kanban = this.getKanban();
    return (kanban.done || []).length;
  }

  getTodoCount() {
    var kanban = this.getKanban();
    return (kanban.todo || []).length;
  }

  isMilestoneComplete() {
    var ms = this.getActiveMilestone();
    if (!ms || !ms.tasks || ms.tasks.length === 0) return false;
    var kanban = this.getKanban();
    var doneSet = new Set(kanban.done || []);
    return ms.tasks.every(function(id) { return doneSet.has(id); });
  }

  // --- Scalable Agent Spawning ---

  getScalableAgentInstances(agentType) {
    var baseType = agentType.replace(/-\d+$/, '');

    if (baseType === 'developer') {
      var designedTasks = this.getTasksWithDesign();
      if (designedTasks <= 0) return [];
      var devCount = Math.max(1, Math.min(designedTasks, this.maxDevs));
      var devInstances = [];
      for (var i = 1; i <= devCount; i++) {
        devInstances.push(baseType + '-' + i);
      }
      return devInstances;
    }

    if (baseType === 'tester') {
      var reviewCount = this.getReviewCount();
      if (reviewCount <= 0) return [];
      // Task 3: Increased tester count from 2 to 4
      var testCount = Math.min(Math.ceil(reviewCount / 2), 4);
      var testInstances = [];
      for (var j = 1; j <= testCount; j++) {
        testInstances.push(baseType + '-' + j);
      }
      return testInstances;
    }

    // Non-scalable: just return the agent type itself
    return [baseType];
  }

  // --- Event Handlers (Config-Driven) ---

  async onProjectStart() {
    this.log('milestone_complete', null, '=== PROJECT START ===');

    // 检查配置版本
    var config = this.loadWorkflowConfig();
    this.log('agent_start', 'workflow', 'Config version: ' + config.version);
    
    if (parseFloat(config.version) >= 3.0) {
      // v3.0+: 使用 WorkflowEngine
      this.log('agent_start', 'workflow', 'Using v3.0 WorkflowEngine');
      const engine = new WorkflowEngine(config, this);
      await engine.execute();
    } else {
      // v2.0: 使用原有逻辑
      this.log('agent_start', 'workflow', 'Using v2.0 workflow');
      var startup = config.workflow.startup;
      
      if (!startup || !Array.isArray(startup)) {
        this.log('error', 'workflow', 'Invalid v2.0 config: workflow.startup must be an array');
        return;
      }

      // Execute startup steps sequentially
      for (var i = 0; i < startup.length; i++) {
        var step = startup[i];

        // Check condition
        if (step.condition && !this.evaluateCondition(step.condition)) {
          this.log('agent_complete', step.agents.join(','), 'Condition not met (' + step.condition + '), skipping');
          continue;
        }

        if (step.parallel) {
          // Run all agents in parallel
          this.log('agent_start', step.agents.join(','), 'Running in parallel...');
          var parallelPromises = [];
          for (var j = 0; j < step.agents.length; j++) {
            parallelPromises.push(this.runAgent(step.agents[j]));
          }
          await Promise.all(parallelPromises);
        } else {
          // Run agents serially
          for (var k = 0; k < step.agents.length; k++) {
            await this.runAgent(step.agents[k]);
          }
        }
      }

      // Enter work loop
      await this.workLoop();
    }
  }

  async workLoop() {
    this.log('agent_start', 'work_loop', '=== WORK LOOP ===');
    this.workLoopCount++;

    var config = this.loadWorkflowConfig();
    var loopConfig = config.workflow.loop;
    var agentsConfig = config.agents;

    var designedTasks = this.getTasksWithDesign();
    var reviewCount = this.getReviewCount();
    var todoCount = this.getTodoCount();

    if (todoCount === 0 && reviewCount === 0) {
      this.log('agent_complete', 'work_loop', 'No work available, waiting...');
      return;
    }

    this.log('agent_start', 'work_loop', 'Work: todo=' + todoCount + ', hasDesign=' + designedTasks + ', review=' + reviewCount);

    // 全并行：Tech Lead + Developer + Tester
    var parallel = [];
    var parallelAgents = loopConfig.parallel || [];

    for (var i = 0; i < parallelAgents.length; i++) {
      var agentName = parallelAgents[i];
      var agentConf = agentsConfig[agentName];

      if (agentConf && agentConf.scalable) {
        // Scalable agent: spawn N instances based on available work
        var instances = this.getScalableAgentInstances(agentName);
        for (var j = 0; j < instances.length; j++) {
          parallel.push(this.runAgent(instances[j]));
        }
      } else {
        // Non-scalable: check if there's work for this agent
        if (agentName === 'tech_lead' && todoCount <= 0) continue;
        parallel.push(this.runAgent(agentName));
      }
    }

    if (parallel.length > 0) {
      await Promise.all(parallel);
    }

    // Check for pending CRs after each work loop
    this.checkPendingCRs();

    // Check for stuck tasks
    this.checkStuckTasks();

    // Then phase: PM 再分配任务
    var thenAgents = loopConfig.then || [];
    for (var t = 0; t < thenAgents.length; t++) {
      this.log('agent_start', thenAgents[t], 'Agents completed, running ' + thenAgents[t]);
      await this.runAgent(thenAgents[t]);
    }

    // Check milestone completion
    if (this.isMilestoneComplete()) {
      await this.onMilestoneComplete();
      return;
    }

    // Continue loop if there's still work
    var kanban = this.getKanban();
    if ((kanban.todo || []).length > 0 || (kanban.review || []).length > 0) {
      await this.workLoop();
    } else {
      this.log('agent_complete', 'work_loop', 'No more work, entering standby');
    }
  }

  async onMilestoneComplete() {
    var ms = this.getActiveMilestone();
    var msId = ms ? ms.id : '?';
    var msName = ms ? ms.name : 'Unknown';
    this.log('milestone_complete', msId, '=== MILESTONE ' + msId + ' COMPLETE: ' + msName + ' ===');

    // Notify
    await this.notify('里程碑完成: ' + msName, msName + ' 已完成，正在运行四重检查...', 'milestone_complete');

    // Ensure review directory exists
    if (ms) {
      var reviewDir = path.join(this.projectDir, '.team/milestones', msId, 'review');
      if (!fs.existsSync(reviewDir)) {
        fs.mkdirSync(reviewDir, { recursive: true });
      }
    }

    // Run milestoneCheck from config
    var config = this.loadWorkflowConfig();
    var msCheck = config.workflow.milestoneCheck;

    // Parallel phase: monitors
    this.log('agent_start', 'monitors', 'Running milestone review monitors...');
    var parallelAgents = msCheck.parallel || [];
    var parallelPromises = [];
    for (var i = 0; i < parallelAgents.length; i++) {
      parallelPromises.push(this.runAgent(parallelAgents[i]));
    }
    await Promise.all(parallelPromises);

    // Task 3: Cross-Validation of Match Percentages
    this.crossValidateMonitors(msId);

    // Gaps summary
    this.log('agent_complete', 'monitors', 'Monitors done, PM planning next milestone');

    // Notify with review results
    var reviewSummary = '';
    var gapsDir = path.join(this.projectDir, '.team/gaps');
    var gapFiles = ['vision.json', 'prd.json', 'dbb.json', 'architecture.json'];
    for (var g = 0; g < gapFiles.length; g++) {
      try {
        var gapData = JSON.parse(fs.readFileSync(path.join(gapsDir, gapFiles[g]), 'utf8'));
        var matchVal = gapData.match != null ? gapData.match : (gapData.coverage != null ? gapData.coverage : 0);
        reviewSummary += gapFiles[g].replace('.json', '') + ': ' + matchVal + '% ';
      } catch {}
    }
    await this.notify(msName + ' 检查完成', reviewSummary.trim(), 'milestone_review_complete');

    // Check for pending CRs (Task 1)
    this.checkPendingCRs();

    // Task 6: Auto Git Commit on Milestone Complete
    if (config.git && config.git.tagPerMilestone) {
      this.autoGitCommit(msId, msName);
    }

    // Then phase: run agents from milestoneCheck.then serially
    var thenAgents = msCheck.then || [];
    for (var t = 0; t < thenAgents.length; t++) {
      await this.runAgent(thenAgents[t]);
    }

    // Reset work loop counter for next milestone
    this.workLoopCount = 0;

    // Continue with work loop
    await this.workLoop();
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
      var summaryDir = path.join(this.projectDir, '.team/milestones', msId, 'review');
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
      this.log('milestone_complete', msId, 'Cross-validation: verified match=' + verifiedMatch + '%');
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
      execSync('git add -A && git tag -a ' + msId + '-complete -m "milestone ' + msId + ' complete: ' + msName + '"', {
        cwd: this.projectDir,
        stdio: 'pipe'
      });
      this.log('milestone_complete', msId, 'Auto git tag: ' + msId + '-complete');
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
      var active = (milestones.milestones || []).find(function(m) { return m.status === 'active'; });

      if (!milestones.milestones || milestones.milestones.length === 0) {
        // No milestones → project start
        await this.onProjectStart();
      } else if (this.isMilestoneComplete()) {
        await this.onMilestoneComplete();
      } else if (active) {
        // Active milestone - check version
        if (parseFloat(config.version) >= 3.0) {
          const WorkflowEngine = require('./workflow-engine-v3');
          const engine = new WorkflowEngine(config, this);
          await engine.executeNode('work_loop');
        } else {
          // v2.0: use legacy workLoop
          await this.workLoop();
        }
      } else {
        // All milestones completed, no active one
        this.log('agent_start', 'pm', 'All milestones completed, checking for new work...');
        await this.runAgent('pm');
        var newActive = this.getActiveMilestone();
        if (newActive) {
          if (parseFloat(config.version) >= 3.0) {
            const WorkflowEngine = require('./workflow-engine-v3');
            const engine = new WorkflowEngine(config, this);
            await engine.executeNode('work_loop');
          } else {
            await this.workLoop();
          }
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
    this.running = true;
    this.log('agent_start', 'daemon', 'DevTeam daemon started (safety=' + (SAFETY_INTERVAL / 1000) + 's, timeout=' + (AGENT_TIMEOUT / 1000) + 's)');

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
var devsArg = process.argv.find(function(a) { return a.startsWith('--devs='); });
var maxDevs = devsArg ? parseInt(devsArg.split('=')[1]) : 3;

var daemon = new TeamDaemon(projectDir, { devs: maxDevs });

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
