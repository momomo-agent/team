/**
 * DevTeam Monitor — 独立健康监控
 * 
 * 监控指标：
 * 1. agent_timeout  — agent 运行超过阈值
 * 2. task_loop      — 任务状态反复跳动
 * 3. no_progress    — 长时间无推进
 * 4. cr_explosion   — pending CR 过多
 * 5. memory_leak    — 内存持续增长
 * 6. high_failure_rate — agent 失败率过高
 * 
 * 使用:
 *   const m = new DevTeamMonitor(daemon);
 *   m.start();
 * 
 * 告警通过 daemon.eventBus 发送 'monitor_alert' 事件。
 */

const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL = 30 * 1000;
const ALERT_DEDUP_WINDOW = 5 * 60 * 1000;

const DEFAULT_THRESHOLDS = {
  agentTimeout: 10 * 60 * 1000,
  noProgress: 5 * 60 * 1000,
  loopStates: 6,
  crExplosion: 20,
  memoryGrowthMB: 500,
  failureRate: 0.3,
  minSamplesForRate: 5,
};

class DevTeamMonitor {
  constructor(daemon, options = {}) {
    this.daemon = daemon;
    this.projectDir = daemon.projectDir;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.interval = options.interval || CHECK_INTERVAL;

    this.history = {
      taskStates: new Map(),
      lastProgress: Date.now(),
      lastDoneCount: 0,
      memorySnapshots: [],
      agentStats: new Map(),
    };
    this.alertCache = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.daemon.log('workflow', 'monitor', '[HEALTH] Monitor started');
    this.timer = setInterval(() => this.runChecks(), this.interval);
    // 首次延迟 10s 避免和 daemon 启动冲突
    setTimeout(() => this.runChecks(), 10000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runChecks() {
    try {
      this.checkAgentTimeout();
      this.checkTaskLoop();
      this.checkProgress();
      this.checkCRExplosion();
      this.checkMemory();
      this.checkFailureRate();
    } catch (err) {
      this.daemon.log('workflow', 'monitor', `Check failed: ${err.message}`);
    }
  }

  // ─── Individual Checks ───

  checkAgentTimeout() {
    const statusPath = path.join(this.projectDir, '.team/agent-status.json');
    if (!fs.existsSync(statusPath)) return;

    let status;
    try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return; }
    const now = Date.now();

    for (const [agentId, info] of Object.entries(status)) {
      if (info.status === 'running' && info.startTime) {
        const runtime = now - new Date(info.startTime).getTime();
        if (runtime > this.thresholds.agentTimeout) {
          this.alert('agent_timeout',
            `${agentId} running for ${Math.round(runtime / 60000)}min`);
        }
      }
    }
  }

  checkTaskLoop() {
    // 从 task.json 文件扫描（kanban.json 已废弃）
    const tasksDir = path.join(this.projectDir, '.team/tasks');
    if (!fs.existsSync(tasksDir)) return;

    const dirs = fs.readdirSync(tasksDir).filter(d =>
      fs.existsSync(path.join(tasksDir, d, 'task.json'))
    );

    for (const taskId of dirs) {
      let task;
      try {
        task = JSON.parse(fs.readFileSync(
          path.join(tasksDir, taskId, 'task.json'), 'utf8'));
      } catch { continue; }

      if (task.status === 'done') continue; // 已完成的不追踪

      if (!this.history.taskStates.has(taskId)) {
        this.history.taskStates.set(taskId, []);
      }
      const states = this.history.taskStates.get(taskId);
      states.push(task.status);
      if (states.length > 12) states.shift();

      // 检测 ping-pong：连续状态交替跳动（A→B→A→B 模式）
      if (states.length >= this.thresholds.loopStates) {
        const recent = states.slice(-this.thresholds.loopStates);
        const unique = new Set(recent);
        if (unique.size === 2) {
          // 计算实际交替次数（状态发生变化的次数）
          let transitions = 0;
          for (let i = 1; i < recent.length; i++) {
            if (recent[i] !== recent[i - 1]) transitions++;
          }
          // 真正的 ping-pong: 交替次数 >= 4（至少来回跳 2 轮）
          if (transitions >= 4) {
            const pattern = recent.join('→');
            this.alert('task_loop', `${taskId} ping-ponging: ${pattern}`);
          }
        }
      }
    }
  }

  checkProgress() {
    const kanban = this.daemon.getKanban ? this.daemon.getKanban() : null;
    if (!kanban) return;

    const doneCount = (kanban.done || []).length;
    const activeCount = (kanban.todo || []).length
      + (kanban.inProgress || []).length
      + (kanban.review || []).length
      + (kanban.testing || []).length;

    if (doneCount > this.history.lastDoneCount) {
      this.history.lastProgress = Date.now();
      this.history.lastDoneCount = doneCount;
    }

    const idleTime = Date.now() - this.history.lastProgress;
    if (idleTime > this.thresholds.noProgress && activeCount > 0) {
      this.alert('no_progress',
        `No progress for ${Math.round(idleTime / 60000)}min (active:${activeCount}, done:${doneCount})`);
    }
  }

  checkCRExplosion() {
    const crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return;

    let pending = 0;
    const files = fs.readdirSync(crDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const cr = JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8'));
        if (cr.status === 'pending') pending++;
      } catch {}
    }

    if (pending > this.thresholds.crExplosion) {
      this.alert('cr_explosion', `${pending} pending CRs`);
    }
  }

  checkMemory() {
    const logPath = path.join(this.projectDir, '.team/daemon.log');
    if (!fs.existsSync(logPath)) return;

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-200);
    const memories = [];
    for (const line of lines) {
      // 匹配 daemon.js 性能日志: "rss":"56MB"
      const m = line.match(/"rss":"(\d+)MB"/);
      if (m) memories.push(parseInt(m[1]));
    }

    if (memories.length < 3) return;
    const recent = memories.slice(-5);
    const growth = recent[recent.length - 1] - recent[0];
    if (growth > this.thresholds.memoryGrowthMB) {
      this.alert('memory_leak',
        `Memory grew ${growth}MB over ${recent.length} samples`);
    }
  }

  checkFailureRate() {
    const logPath = path.join(this.projectDir, '.team/daemon.log');
    if (!fs.existsSync(logPath)) return;

    // 只看最近 200 行
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-200);

    // 重置统计（基于最近 200 行窗口）
    const stats = new Map();
    for (const line of lines) {
      // daemon.log 是文本格式，不是 JSON — 匹配模式
      // [timestamp] [agent_complete] <agent> completed successfully
      // [timestamp] [agent_failed] <agent> ...
      const complete = line.match(/\[agent_complete\]\s+(\S+)/);
      const failed = line.match(/\[agent_failed\]\s+(\S+)/);

      if (complete) {
        const agent = complete[1].replace(/-\d+$/, ''); // strip instance suffix
        if (!stats.has(agent)) stats.set(agent, { success: 0, failure: 0 });
        stats.get(agent).success++;
      }
      if (failed) {
        const agent = failed[1].replace(/-\d+$/, '');
        if (!stats.has(agent)) stats.set(agent, { success: 0, failure: 0 });
        stats.get(agent).failure++;
      }
    }

    for (const [agent, s] of stats) {
      const total = s.success + s.failure;
      if (total >= this.thresholds.minSamplesForRate) {
        const rate = s.failure / total;
        if (rate > this.thresholds.failureRate) {
          this.alert('high_failure_rate',
            `${agent}: ${Math.round(rate * 100)}% failure (${s.failure}/${total})`);
        }
      }
    }
  }

  // ─── Alert Dispatch ───

  alert(type, message) {
    const key = `${type}:${message}`;
    const now = Date.now();
    const last = this.alertCache.get(key);
    if (last && now - last < ALERT_DEDUP_WINDOW) return;
    this.alertCache.set(key, now);

    const ts = new Date().toISOString();
    this.daemon.log('workflow', 'monitor', `⚠️ [ALERT:${type}] ${message}`);

    // 通过 EventBus 发事件
    if (this.daemon.eventBus) {
      this.daemon.eventBus.emit('monitor_alert', 'monitor', {
        details: JSON.stringify({ type, message }),
      });
    }

    // 写告警日志
    const alertLog = path.join(this.projectDir, '.team/monitor-alerts.log');
    fs.appendFileSync(alertLog, JSON.stringify({ time: ts, type, message }) + '\n');
  }
}

module.exports = DevTeamMonitor;

// CLI 独立运行支持
if (require.main === module) {
  const projectDir = process.argv[2] || process.cwd();
  const mockDaemon = {
    projectDir,
    log: (level, src, msg) => {
      const prefix = level === 'error' ? '⚠️ ' : '';
      console.log(`${prefix}[${src}] ${msg}`);
    },
    getKanban: () => {
      const tasksDir = path.join(projectDir, '.team/tasks');
      const k = { todo: [], inProgress: [], review: [], testing: [], done: [], blocked: [] };
      if (!fs.existsSync(tasksDir)) return k;
      for (const d of fs.readdirSync(tasksDir)) {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(tasksDir, d, 'task.json'), 'utf8'));
          if (k[t.status]) k[t.status].push(d);
        } catch {}
      }
      return k;
    },
    eventBus: null,
  };
  const m = new DevTeamMonitor(mockDaemon);
  m.start();
}
