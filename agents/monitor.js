#!/usr/bin/env node
/**
 * DevTeam Monitor - 独立监控系统
 * 
 * 监控指标：
 * 1. 卡死检测：agent 运行时间过长
 * 2. 自循环检测：任务在状态间反复
 * 3. 无推进检测：长时间无状态变化
 * 4. CR 爆炸检测：pending CR 过多
 * 5. 内存泄漏检测：内存持续增长
 * 6. Agent 失败率：失败次数过多
 */

const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL = 30 * 1000; // 30 秒检查一次
const THRESHOLDS = {
  agentTimeout: 10 * 60 * 1000,      // agent 运行超过 10 分钟
  noProgress: 5 * 60 * 1000,         // 5 分钟无推进
  loopDetection: 3,                  // 同一任务循环 3 次
  crExplosion: 20,                   // pending CR 超过 20
  memoryGrowth: 500,                 // 内存增长超过 500MB
  failureRate: 0.3                   // 失败率超过 30%
};

class DevTeamMonitor {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.history = {
      taskStates: new Map(),           // taskId -> [states]
      agentStarts: new Map(),          // agentId -> startTime
      lastProgress: Date.now(),        // 最后一次推进时间
      memorySnapshots: [],             // 内存快照
      agentStats: new Map()            // agentId -> {success, failure}
    };
    this.alertCache = new Map();       // 修复 5: 告警去重缓存 (type+message -> timestamp)
  }

  start() {
    console.log('[Monitor] Starting DevTeam monitor...');
    this.checkLoop();
  }

  checkLoop() {
    this.runChecks();
    setTimeout(() => this.checkLoop(), CHECK_INTERVAL);
  }

  runChecks() {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Running health checks...`);

    try {
      this.checkAgentTimeout();
      this.checkTaskLoop();
      this.checkProgress();
      this.checkCRExplosion();
      this.checkMemory();
      this.checkFailureRate();
    } catch (err) {
      console.error('[Monitor] Check failed:', err.message);
    }
  }

  checkAgentTimeout() {
    const statusPath = path.join(this.projectDir, '.team/agent-status.json');
    if (!fs.existsSync(statusPath)) return;

    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const now = Date.now();

    for (const [agentId, info] of Object.entries(status)) {
      if (info.status === 'running' && info.startTime) {
        const runtime = now - new Date(info.startTime).getTime();
        if (runtime > THRESHOLDS.agentTimeout) {
          this.alert('agent_timeout', `Agent ${agentId} running for ${Math.round(runtime/60000)}min`);
        }
      }
    }
  }

  checkTaskLoop() {
    const kanbanPath = path.join(this.projectDir, '.team/kanban.json');
    if (!fs.existsSync(kanbanPath)) return;

    const kanban = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    const allTasks = [...(kanban.todo || []), ...(kanban.inProgress || [])];

    for (const taskId of allTasks) {
      if (!this.history.taskStates.has(taskId)) {
        this.history.taskStates.set(taskId, []);
      }
      const states = this.history.taskStates.get(taskId);
      const currentState = kanban.inProgress.includes(taskId) ? 'inProgress' : 'todo';
      
      states.push(currentState);
      if (states.length > 10) states.shift();

      // 检测循环：todo -> inProgress -> todo -> inProgress
      if (states.length >= 6) {
        const pattern = states.slice(-6).join(',');
        if (pattern === 'todo,inProgress,todo,inProgress,todo,inProgress') {
          this.alert('task_loop', `Task ${taskId} looping between todo/inProgress`);
        }
      }
    }
  }

  checkProgress() {
    const kanbanPath = path.join(this.projectDir, '.team/kanban.json');
    if (!fs.existsSync(kanbanPath)) return;

    const kanban = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    const doneCount = (kanban.done || []).length;

    if (doneCount > this.lastDoneCount) {
      this.history.lastProgress = Date.now();
      this.lastDoneCount = doneCount;
    }

    const timeSinceProgress = Date.now() - this.history.lastProgress;
    if (timeSinceProgress > THRESHOLDS.noProgress) {
      const todoCount = (kanban.todo || []).length;
      const inProgressCount = (kanban.inProgress || []).length;
      if (todoCount > 0 || inProgressCount > 0) {
        this.alert('no_progress', `No progress for ${Math.round(timeSinceProgress/60000)}min (todo:${todoCount}, inProgress:${inProgressCount})`);
      }
    }
  }

  checkCRExplosion() {
    const crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return;

    const files = fs.readdirSync(crDir).filter(f => f.endsWith('.json'));
    let pendingCount = 0;

    for (const file of files) {
      try {
        const cr = JSON.parse(fs.readFileSync(path.join(crDir, file), 'utf8'));
        if (cr.status === 'pending') pendingCount++;
      } catch {}
    }

    if (pendingCount > THRESHOLDS.crExplosion) {
      this.alert('cr_explosion', `${pendingCount} pending CRs detected`);
    }
  }

  checkMemory() {
    const daemonLog = path.join(this.projectDir, '.team/daemon.log');
    if (!fs.existsSync(daemonLog)) return;

    // 读取最近的性能日志
    const lines = fs.readFileSync(daemonLog, 'utf8').split('\n').slice(-100);
    const perfLogs = lines.filter(l => l.includes('"event":"perf"')).slice(-5);

    if (perfLogs.length < 2) return;

    const memories = perfLogs.map(line => {
      try {
        const log = JSON.parse(line);
        return parseInt(log.details.match(/rss:(\d+)MB/)[1]);
      } catch { return 0; }
    });

    const growth = memories[memories.length - 1] - memories[0];
    if (growth > THRESHOLDS.memoryGrowth) {
      this.alert('memory_leak', `Memory grew ${growth}MB in last ${perfLogs.length} checks`);
    }
  }

  checkFailureRate() {
    const logPath = path.join(this.projectDir, '.team/daemon.log');
    if (!fs.existsSync(logPath)) return;

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-200);
    
    for (const line of lines) {
      try {
        const log = JSON.parse(line);
        if (log.event === 'agent_complete') {
          const agent = log.agent;
          if (!this.history.agentStats.has(agent)) {
            this.history.agentStats.set(agent, {success: 0, failure: 0});
          }
          this.history.agentStats.get(agent).success++;
        } else if (log.event === 'agent_failed') {
          const agent = log.agent;
          if (!this.history.agentStats.has(agent)) {
            this.history.agentStats.set(agent, {success: 0, failure: 0});
          }
          this.history.agentStats.get(agent).failure++;
        }
      } catch {}
    }

    for (const [agent, stats] of this.history.agentStats) {
      const total = stats.success + stats.failure;
      if (total >= 5) {
        const rate = stats.failure / total;
        if (rate > THRESHOLDS.failureRate) {
          this.alert('high_failure_rate', `Agent ${agent} failure rate: ${Math.round(rate*100)}%`);
        }
      }
    }
  }

  alert(type, message) {
    const timestamp = new Date().toISOString();
    
    // 修复 5: 5 分钟内相同告警只发一次
    const alertKey = `${type}:${message}`;
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;
    
    if (this.alertCache.has(alertKey)) {
      const lastAlert = this.alertCache.get(alertKey);
      if (now - lastAlert < FIVE_MINUTES) {
        return; // 5 分钟内已发过，跳过
      }
    }
    
    this.alertCache.set(alertKey, now);
    
    console.error(`[${timestamp}] ⚠️  ALERT [${type}] ${message}`);
    
    // 写入告警日志
    const alertLog = path.join(this.projectDir, '.team/monitor-alerts.log');
    const alert = JSON.stringify({time: timestamp, type, message}) + '\n';
    fs.appendFileSync(alertLog, alert);
  }
}

// CLI
const projectDir = process.argv[2] || process.cwd();
const monitor = new DevTeamMonitor(projectDir);
monitor.lastDoneCount = 0;
monitor.start();
