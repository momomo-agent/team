#!/usr/bin/env node
/**
 * DevTeam Daemon - Event-driven orchestrator
 *
 * Event model (from DESIGN.md):
 *   Project start: architect(serial) → monitors(parallel) → PM → work loop
 *   Work loop: tech_lead + developer-N(only tasks with design) + tester-N (all parallel) → PM re-assign → loop
 *   Milestone complete: 4 monitors parallel (vision + prd + dbb + arch) → gaps → PM next milestone
 *   Safety interval: 10 min
 *   Agent timeout: 60 min
 *   nohup-compatible (no stdin needed)
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAFETY_INTERVAL = 10 * 60 * 1000; // 10 min
const AGENT_TIMEOUT = 60 * 60 * 1000;   // 60 min
const RUNNER = path.join(__dirname, 'runner.js');
const MAX_HISTORY_ENTRIES = 500;

class TeamDaemon {
  constructor(projectDir, opts = {}) {
    this.projectDir = projectDir;
    this.running = false;
    this.busy = false;
    this.maxDevs = opts.devs || 3;
    this.workLoopCount = 0;
  }

  // --- Structured Logging (Task 7) ---

  log(event, agent, details) {
    const entry = {
      time: new Date().toISOString(),
      event: event,
      agent: agent || null,
      details: details || null
    };

    // Console output
    console.log(`[${ts()}] [${event}] ${agent || ''} ${details || ''}`);

    // Append to daemon-history.json
    const historyPath = path.join(this.projectDir, '.team/daemon-history.json');
    let history = [];
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch {}
    history.push(entry);
    // Keep last MAX_HISTORY_ENTRIES entries
    if (history.length > MAX_HISTORY_ENTRIES) {
      history = history.slice(history.length - MAX_HISTORY_ENTRIES);
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  // --- Agent Execution ---

  runAgent(agentType) {
    return new Promise((resolve) => {
      const baseType = agentType.replace(/-\d+$/, '');
      const taskDesc = {
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

      this.log('agent_start', agentType, taskDesc[baseType] || agentType);
      this.updateAgentStatus(agentType, 'running', taskDesc[baseType] || agentType);

      const proc = spawn('node', [RUNNER, agentType, this.projectDir], {
        stdio: ['ignore', 'inherit', 'inherit'] // no stdin (nohup-compatible)
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
      }, AGENT_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          this.updateAgentStatus(agentType, 'idle', null);
          this.log('agent_complete', agentType, 'completed successfully');

          // Auto git commit after developer or tester completes
          if (baseType === 'developer' || baseType === 'tester') {
            try {
              const prefix = baseType === 'developer' ? 'feat' : 'test';
              execSync(`git add -A && git diff --cached --quiet || git commit -m "${prefix}: ${agentType} completed"`, {
                cwd: this.projectDir,
                stdio: 'pipe'
              });
            } catch {}
          }

          resolve(true);
        } else {
          // Task 4: Error Recovery — retry once on failure
          const statusPath = path.join(this.projectDir, '.team/agent-status.json');
          let all = {};
          try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
          const retryCount = (all[agentType] && all[agentType].retryCount) || 0;

          if (retryCount < 1) {
            this.log('error', agentType, `failed (code=${code}), retrying (attempt ${retryCount + 1})`);
            this.updateAgentStatus(agentType, 'retrying', null, retryCount + 1);
            // Retry once
            this.runAgent(agentType).then(resolve);
          } else {
            this.updateAgentStatus(agentType, 'error', null, retryCount);
            this.log('error', agentType, `failed (code=${code}) after retry, marking as error`);
            resolve(false);
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.updateAgentStatus(agentType, 'error', err.message);
        this.log('error', agentType, `spawn error: ${err.message}`);
        resolve(false);
      });
    });
  }

  updateAgentStatus(agentType, status, task, retryCount) {
    const statusPath = path.join(this.projectDir, '.team/agent-status.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    all[agentType] = {
      status,
      lastRun: new Date().toISOString(),
      currentTask: task || null,
      retryCount: retryCount != null ? retryCount : (all[agentType] && all[agentType].retryCount) || 0
    };
    fs.writeFileSync(statusPath, JSON.stringify(all, null, 2));
  }

  // --- Notifications ---

  async notify(title, message) {
    const configPath = path.join(this.projectDir, '.team/config.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    const notifyConfig = config.notify || {};

    // macOS notification
    if (notifyConfig.macos) {
      try {
        execSync(`osascript -e 'display notification "${message}" with title "DevTeam: ${title}"'`);
      } catch {}
    }

    // Write to notifications file (for Momo heartbeat to pick up and send to Discord)
    const notifPath = path.join(this.projectDir, '.team/notifications.json');
    let notifs = [];
    try { notifs = JSON.parse(fs.readFileSync(notifPath, 'utf8')); } catch {}
    notifs.push({
      title,
      message,
      channel: notifyConfig.discord && notifyConfig.discord.channel ? notifyConfig.discord.channel : null,
      timestamp: new Date().toISOString(),
      sent: false
    });
    fs.writeFileSync(notifPath, JSON.stringify(notifs, null, 2));
  }

  // --- CR Checking (Task 1) ---

  checkPendingCRs() {
    const crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return;

    let files;
    try { files = fs.readdirSync(crDir).filter(function(f) { return f.endsWith('.json'); }); } catch { return; }

    for (const f of files) {
      try {
        const cr = JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8'));
        if (cr.status === 'pending') {
          this.log('cr_created', cr.from || 'unknown', `CR ${cr.id || f}: ${cr.reason || 'no reason'}`);
          this.notify('Change Request', `[${cr.from}] ${cr.reason || 'New CR pending'}`);
        }
      } catch {}
    }
  }

  // --- Task 4: Stuck task detection ---

  checkStuckTasks() {
    const kanban = this.getKanban();
    const inProgress = kanban.inProgress || [];
    if (inProgress.length === 0) return;

    const statusPath = path.join(this.projectDir, '.team/agent-status.json');
    let agentStatus = {};
    try { agentStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}

    // Check if any agents are still running — if none are running but tasks are inProgress, they may be stuck
    const anyRunning = Object.values(agentStatus).some(function(a) { return a.status === 'running'; });
    if (anyRunning) return; // agents still working, not stuck yet

    // If we've done 2+ work loops with same inProgress tasks, move them back to todo
    if (this.workLoopCount >= 2 && inProgress.length > 0) {
      const TaskManager = require(path.join(__dirname, '../lib/task-manager.js'));
      const tm = new TaskManager(this.projectDir);
      for (const taskId of inProgress) {
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
    const p = path.join(this.projectDir, '.team/kanban.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
    }
  }

  getMilestones() {
    const p = path.join(this.projectDir, '.team/milestones/milestones.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { milestones: [] };
    }
  }

  getActiveMilestone() {
    const data = this.getMilestones();
    return (data.milestones || []).find(function(m) { return m.status === 'active'; }) || null;
  }

  getTasksWithDesign() {
    const kanban = this.getKanban();
    const todoIds = kanban.todo || [];
    let count = 0;
    for (const tid of todoIds) {
      const taskPath = path.join(this.projectDir, '.team/tasks', tid, 'task.json');
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        if (task.hasDesign) count++;
      } catch {}
    }
    return count;
  }

  getReviewCount() {
    const kanban = this.getKanban();
    return (kanban.review || []).length;
  }

  getTodoCount() {
    const kanban = this.getKanban();
    return (kanban.todo || []).length;
  }

  isMilestoneComplete() {
    const ms = this.getActiveMilestone();
    if (!ms || !ms.tasks || ms.tasks.length === 0) return false;
    const kanban = this.getKanban();
    const doneSet = new Set(kanban.done || []);
    return ms.tasks.every(function(id) { return doneSet.has(id); });
  }

  // --- Event Handlers ---

  async onProjectStart() {
    this.log('milestone_complete', null, '=== PROJECT START ===');

    // 1. Architect (serial) — only if no architecture
    const archPath = path.join(this.projectDir, 'ARCHITECTURE.md');
    if (!fs.existsSync(archPath) || fs.readFileSync(archPath, 'utf8').trim().length < 100) {
      await this.runAgent('architect');
    } else {
      this.log('agent_complete', 'architect', 'Architecture exists, skipping');
    }

    // 2. Monitors in parallel (initial assessment)
    this.log('agent_start', 'monitors', 'Running initial monitors...');
    await Promise.all([
      this.runAgent('vision_monitor'),
      this.runAgent('prd_monitor'),
      this.runAgent('dbb_monitor'),
      this.runAgent('arch_monitor')
    ]);

    // 3. PM creates milestones (serial)
    await this.runAgent('pm');

    // 4. Enter work loop
    await this.workLoop();
  }

  async workLoop() {
    this.log('agent_start', 'work_loop', '=== WORK LOOP ===');
    this.workLoopCount++;

    const designedTasks = this.getTasksWithDesign();
    const reviewCount = this.getReviewCount();
    const todoCount = this.getTodoCount();

    if (todoCount === 0 && reviewCount === 0) {
      this.log('agent_complete', 'work_loop', 'No work available, waiting...');
      return;
    }

    this.log('agent_start', 'work_loop', `Work: todo=${todoCount}, hasDesign=${designedTasks}, review=${reviewCount}`);

    // All parallel: tech_lead + developer-N + tester-N
    const parallel = [];

    // Tech Lead always runs if there are todo tasks (to design undesigned ones)
    if (todoCount > 0) {
      parallel.push(this.runAgent('tech_lead'));
    }

    // Developers: only spawn if there are tasks with designs
    if (designedTasks > 0) {
      const devCount = Math.max(1, Math.min(designedTasks, this.maxDevs));
      for (let i = 1; i <= devCount; i++) {
        parallel.push(this.runAgent(`developer-${i}`));
      }
    }

    // Testers: only spawn if there are tasks in review
    if (reviewCount > 0) {
      const testCount = Math.min(Math.ceil(reviewCount / 2), 2);
      for (let i = 1; i <= testCount; i++) {
        parallel.push(this.runAgent(`tester-${i}`));
      }
    }

    if (parallel.length > 0) {
      await Promise.all(parallel);
    }

    // Check for pending CRs after each work loop (Task 1)
    this.checkPendingCRs();

    // Check for stuck tasks (Task 4)
    this.checkStuckTasks();

    // PM re-assign
    this.log('agent_start', 'pm', 'Agents completed, PM re-assign');
    await this.runAgent('pm');

    // Check milestone completion
    if (this.isMilestoneComplete()) {
      await this.onMilestoneComplete();
      return;
    }

    // Continue loop if there's still work
    const kanban = this.getKanban();
    if ((kanban.todo || []).length > 0 || (kanban.review || []).length > 0) {
      await this.workLoop();
    } else {
      this.log('agent_complete', 'work_loop', 'No more work, entering standby');
    }
  }

  async onMilestoneComplete() {
    const ms = this.getActiveMilestone();
    const msId = ms ? ms.id : '?';
    const msName = ms ? ms.name : 'Unknown';
    this.log('milestone_complete', msId, `=== MILESTONE ${msId} COMPLETE: ${msName} ===`);

    // Notify
    await this.notify(`里程碑完成: ${msName}`, `${msName} 已完成，正在运行四重检查...`);

    // Ensure review directory exists
    if (ms) {
      const reviewDir = path.join(this.projectDir, '.team/milestones', msId, 'review');
      if (!fs.existsSync(reviewDir)) {
        fs.mkdirSync(reviewDir, { recursive: true });
      }
    }

    // 4 monitors in parallel (vision + prd + dbb + arch)
    this.log('agent_start', 'monitors', 'Running milestone review monitors...');
    await Promise.all([
      this.runAgent('vision_monitor'),
      this.runAgent('prd_monitor'),
      this.runAgent('dbb_monitor'),
      this.runAgent('arch_monitor')
    ]);

    // Task 3: Cross-Validation of Match Percentages
    this.crossValidateMonitors(msId);

    // Gaps summary → PM plans next milestone
    this.log('agent_complete', 'monitors', 'Monitors done, PM planning next milestone');

    // Notify with review results
    let reviewSummary = '';
    const gapsDir = path.join(this.projectDir, '.team/gaps');
    for (const f of ['vision.json', 'prd.json', 'dbb.json', 'architecture.json']) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(gapsDir, f), 'utf8'));
        const matchVal = g.match != null ? g.match : (g.coverage != null ? g.coverage : 0);
        reviewSummary += `${f.replace('.json','')}: ${matchVal}% `;
      } catch {}
    }
    await this.notify(`${msName} 检查完成`, reviewSummary.trim());

    // Check for pending CRs (Task 1)
    this.checkPendingCRs();

    // Task 6: Auto Git Commit on Milestone Complete
    this.autoGitCommit(msId, msName);

    await this.runAgent('pm');

    // Reset work loop counter for next milestone
    this.workLoopCount = 0;

    // Continue with work loop
    await this.workLoop();
  }

  // --- Task 3: Cross-Validation of Match Percentages ---

  crossValidateMonitors(msId) {
    const gapsDir = path.join(this.projectDir, '.team/gaps');
    const monitors = ['vision', 'prd', 'dbb', 'architecture'];
    const matches = {};

    for (const name of monitors) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(gapsDir, `${name}.json`), 'utf8'));
        matches[name] = data.match != null ? data.match : (data.coverage != null ? data.coverage : null);
      } catch {
        matches[name] = null;
      }
    }

    const validMatches = Object.entries(matches).filter(function(entry) { return entry[1] != null; });
    if (validMatches.length < 2) return;

    const values = validMatches.map(function(entry) { return entry[1]; });
    const maxMatch = Math.max.apply(null, values);
    const minMatch = Math.min.apply(null, values);

    // Flag suspicious: any >90% but another <50%
    if (maxMatch > 90 && minMatch < 50) {
      const highMonitors = validMatches.filter(function(e) { return e[1] > 90; }).map(function(e) { return e[0]; });
      const lowMonitors = validMatches.filter(function(e) { return e[1] < 50; }).map(function(e) { return e[0]; });
      const warning = `SUSPICIOUS: ${highMonitors.join(',')} report >90% but ${lowMonitors.join(',')} report <50%`;
      this.log('error', 'cross_validation', warning);
      this.notify('Monitor Cross-Validation Warning', warning);
    }

    // Verified match = minimum across all monitors
    const verifiedMatch = minMatch;

    // Write summary
    if (msId && msId !== '?') {
      const summaryDir = path.join(this.projectDir, '.team/milestones', msId, 'review');
      if (!fs.existsSync(summaryDir)) {
        fs.mkdirSync(summaryDir, { recursive: true });
      }
      const summary = {
        milestoneId: msId,
        timestamp: new Date().toISOString(),
        monitors: matches,
        verifiedMatch: verifiedMatch,
        suspicious: maxMatch > 90 && minMatch < 50
      };
      fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify(summary, null, 2));
      this.log('milestone_complete', msId, `Cross-validation: verified match=${verifiedMatch}%`);
    }
  }

  // --- Task 6: Auto Git Commit on Milestone Complete ---

  autoGitCommit(msId, msName) {
    // Check if there are critical gaps
    const gapsDir = path.join(this.projectDir, '.team/gaps');
    let hasCriticalGaps = false;
    for (const f of ['vision.json', 'prd.json', 'dbb.json', 'architecture.json']) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(gapsDir, f), 'utf8'));
        const matchVal = g.match != null ? g.match : (g.coverage != null ? g.coverage : 0);
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
      execSync(`git add -A && git tag -a ${msId}-complete -m "milestone ${msId} complete: ${msName}"`, {
        cwd: this.projectDir,
        stdio: 'pipe'
      });
      this.log('milestone_complete', msId, `Auto git tag: ${msId}-complete`);
    } catch (err) {
      this.log('error', msId, `Auto git tag failed: ${err.message}`);
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
      const milestones = this.getMilestones();
      const active = (milestones.milestones || []).find(function(m) { return m.status === 'active'; });

      if (!milestones.milestones || milestones.milestones.length === 0) {
        // No milestones → project start
        await this.onProjectStart();
      } else if (this.isMilestoneComplete()) {
        await this.onMilestoneComplete();
      } else if (active) {
        await this.workLoop();
      } else {
        // All milestones completed, no active one
        this.log('agent_start', 'pm', 'All milestones completed, checking for new work...');
        await this.runAgent('pm');
        const newActive = this.getActiveMilestone();
        if (newActive) {
          await this.workLoop();
        }
      }
    } catch (err) {
      this.log('error', 'daemon', `Error in main loop: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  // --- Start / Stop ---

  start() {
    if (this.running) return;
    this.running = true;
    this.log('agent_start', 'daemon', `DevTeam daemon started (safety=${SAFETY_INTERVAL / 1000}s, timeout=${AGENT_TIMEOUT / 1000}s)`);

    // Ensure .team directory exists
    const teamDir = path.join(this.projectDir, '.team');
    if (!fs.existsSync(teamDir)) {
      fs.mkdirSync(teamDir, { recursive: true });
    }

    // Write PID
    const pidPath = path.join(this.projectDir, '.team/daemon.pid');
    fs.writeFileSync(pidPath, process.pid.toString());

    // Immediate start
    this.run();

    // Safety interval: check every 10 minutes
    this.timer = setInterval(() => {
      if (this.running) this.run();
    }, SAFETY_INTERVAL);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    const pidPath = path.join(this.projectDir, '.team/daemon.pid');
    try { fs.unlinkSync(pidPath); } catch {}
    this.log('agent_complete', 'daemon', 'DevTeam daemon stopped');
  }
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// --- Entry Point ---

const projectDir = process.argv[2] || process.cwd();
const devsArg = process.argv.find(function(a) { return a.startsWith('--devs='); });
const maxDevs = devsArg ? parseInt(devsArg.split('=')[1]) : 3;

const daemon = new TeamDaemon(projectDir, { devs: maxDevs });

// Process-level error protection
process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] Uncaught exception:`, err.message);
  // Don't exit — keep running
});

process.on('unhandledRejection', (err) => {
  console.error(`[${ts()}] Unhandled rejection:`, err && err.message ? err.message : err);
  // Don't exit — keep running
});

// Graceful shutdown
process.on('SIGINT', () => { daemon.stop(); process.exit(0); });
process.on('SIGTERM', () => { daemon.stop(); process.exit(0); });

daemon.start();
