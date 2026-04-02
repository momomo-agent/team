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

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAFETY_INTERVAL = 10 * 60 * 1000; // 10 min
const AGENT_TIMEOUT = 60 * 60 * 1000;   // 60 min
const RUNNER = path.join(__dirname, 'runner.js');

class TeamDaemon {
  constructor(projectDir, opts = {}) {
    this.projectDir = projectDir;
    this.running = false;
    this.busy = false;
    this.maxDevs = opts.devs || 3;
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

      console.log(`[${ts()}] ${agentType} starting...`);
      this.updateAgentStatus(agentType, 'running', taskDesc[baseType] || agentType);

      const proc = spawn('node', [RUNNER, agentType, this.projectDir], {
        stdio: ['ignore', 'inherit', 'inherit'] // no stdin (nohup-compatible)
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
      }, AGENT_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const status = code === 0 ? 'idle' : 'error';
        this.updateAgentStatus(agentType, status, null);
        console.log(`[${ts()}] ${code === 0 ? '✅' : '⚠️'} ${agentType} ${code === 0 ? 'completed' : `failed (code=${code})`}`);
        resolve(code === 0);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.updateAgentStatus(agentType, 'error', err.message);
        console.error(`[${ts()}] ❌ ${agentType} error: ${err.message}`);
        resolve(false);
      });
    });
  }

  updateAgentStatus(agentType, status, task = null) {
    const statusPath = path.join(this.projectDir, '.team/agent-status.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    all[agentType] = { status, lastRun: new Date().toISOString(), currentTask: task };
    fs.writeFileSync(statusPath, JSON.stringify(all, null, 2));
  }

  // --- Notifications ---

  async notify(title, message) {
    const configPath = path.join(this.projectDir, '.team/config.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    const notify = config.notify || {};

    // macOS notification
    if (notify.macos) {
      try {
        const { execSync } = require('child_process');
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
      channel: notify.discord?.channel || null,
      timestamp: new Date().toISOString(),
      sent: false
    });
    fs.writeFileSync(notifPath, JSON.stringify(notifs, null, 2));
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
    return (data.milestones || []).find(m => m.status === 'active') || null;
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
    return ms.tasks.every(id => doneSet.has(id));
  }

  // --- Event Handlers ---

  async onProjectStart() {
    console.log(`\n[${ts()}] === PROJECT START ===`);

    // 1. Architect (serial) — only if no architecture
    const archPath = path.join(this.projectDir, 'ARCHITECTURE.md');
    if (!fs.existsSync(archPath) || fs.readFileSync(archPath, 'utf8').trim().length < 100) {
      await this.runAgent('architect');
    } else {
      console.log(`[${ts()}] Architecture exists, skipping architect`);
    }

    // 2. Monitors in parallel (initial assessment)
    console.log(`[${ts()}] Running initial monitors...`);
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
    console.log(`\n[${ts()}] === WORK LOOP ===`);

    const designedTasks = this.getTasksWithDesign();
    const reviewCount = this.getReviewCount();
    const todoCount = this.getTodoCount();

    if (todoCount === 0 && reviewCount === 0) {
      console.log(`[${ts()}] No work available, waiting...`);
      return;
    }

    console.log(`[${ts()}] Work: todo=${todoCount}, hasDesign=${designedTasks}, review=${reviewCount}`);

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

    // PM re-assign
    console.log(`[${ts()}] Agents completed → PM re-assign`);
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
      console.log(`[${ts()}] No more work, entering standby`);
    }
  }

  async onMilestoneComplete() {
    const ms = this.getActiveMilestone();
    const msId = ms ? ms.id : '?';
    const msName = ms ? ms.name : 'Unknown';
    console.log(`\n[${ts()}] === MILESTONE ${msId} COMPLETE ===`);

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
    console.log(`[${ts()}] Running milestone review monitors...`);
    await Promise.all([
      this.runAgent('vision_monitor'),
      this.runAgent('prd_monitor'),
      this.runAgent('dbb_monitor'),
      this.runAgent('arch_monitor')
    ]);

    // Gaps summary → PM plans next milestone
    console.log(`[${ts()}] Monitors done → PM planning next milestone`);

    // Notify with review results
    let reviewSummary = '';
    const gapsDir = path.join(this.projectDir, '.team/gaps');
    for (const f of ['vision.json', 'prd.json', 'architecture.json']) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(gapsDir, f), 'utf8'));
        reviewSummary += `${f.replace('.json','')}: ${g.match || 0}% `;
      } catch {}
    }
    await this.notify(`${msName} 检查完成`, reviewSummary.trim());

    await this.runAgent('pm');

    // Continue with work loop
    await this.workLoop();
  }

  // --- Main Loop (safety interval) ---

  async run() {
    if (this.busy) {
      console.log(`[${ts()}] Still busy, skipping safety check`);
      return;
    }
    this.busy = true;

    try {
      const milestones = this.getMilestones();
      const active = (milestones.milestones || []).find(m => m.status === 'active');

      if (!milestones.milestones || milestones.milestones.length === 0) {
        // No milestones → project start
        await this.onProjectStart();
      } else if (this.isMilestoneComplete()) {
        await this.onMilestoneComplete();
      } else if (active) {
        await this.workLoop();
      } else {
        // All milestones completed, no active one
        console.log(`[${ts()}] All milestones completed, checking for new work...`);
        await this.runAgent('pm');
        const newActive = this.getActiveMilestone();
        if (newActive) {
          await this.workLoop();
        }
      }
    } catch (err) {
      console.error(`[${ts()}] Error in main loop:`, err.message);
    } finally {
      this.busy = false;
    }
  }

  // --- Start / Stop ---

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[${ts()}] DevTeam daemon started (event-driven, safety=${SAFETY_INTERVAL / 1000}s, timeout=${AGENT_TIMEOUT / 1000}s)`);

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
    console.log(`[${ts()}] DevTeam daemon stopped`);
  }
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// --- Entry Point ---

const projectDir = process.argv[2] || process.cwd();
const devsArg = process.argv.find(a => a.startsWith('--devs='));
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
