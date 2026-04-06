/**
 * EventBus — Append-only event log + in-memory pub/sub + fs.watch
 *
 * Usage:
 *   const bus = new EventBus(projectDir);
 *   bus.on('task_status', (event) => { ... });
 *   bus.emit('task_status', 'developer-1', { taskId: 'task-005', from: 'todo', to: 'inProgress' });
 *   bus.startWatching(); // fs.watch on events.log
 *   bus.stopWatching();
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const lockfile = require('proper-lockfile');

class EventBus extends EventEmitter {
  constructor(projectDir) {
    super();
    this.setMaxListeners(100); // Avoid warning for many subscribers
    this.projectDir = projectDir;
    this.logPath = path.join(projectDir, '.team/events.log');
    this.watcher = null;
    this.lastSize = 0;
    this.pollTimer = null;

    // Ensure .team/ exists
    const teamDir = path.join(projectDir, '.team');
    if (!fs.existsSync(teamDir)) {
      fs.mkdirSync(teamDir, { recursive: true });
    }

    // Ensure log file exists (so lockfile can work)
    if (!fs.existsSync(this.logPath)) {
      fs.writeFileSync(this.logPath, '');
    }

    // Track file size for tail
    try {
      this.lastSize = fs.statSync(this.logPath).size;
    } catch {
      this.lastSize = 0;
    }
  }

  /**
   * Emit an event: atomic append to log + in-memory pub/sub
   * Uses proper-lockfile to prevent cross-process write races
   */
  emit(type, agent, data) {
    if (typeof agent === 'object' && data === undefined) {
      data = agent;
      agent = null;
    }

    const event = {
      ts: new Date().toISOString(),
      type: type,
      agent: agent || null,
      data: data || {}
    };

    const line = JSON.stringify(event) + '\n';

    // File segmentation: when current file > 5MB, archive and start fresh
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > 5 * 1024 * 1024) {
        // Find next available segment number
        const dir = path.dirname(this.logPath);
        const existing = fs.readdirSync(dir).filter(f => /^events-\d+\.log$/.test(f));
        const maxSeq = existing.reduce((m, f) => {
          const n = parseInt(f.match(/events-(\d+)\.log/)[1]);
          return Math.max(m, n);
        }, 0);
        const archivePath = path.join(dir, 'events-' + String(maxSeq + 1).padStart(5, '0') + '.log');
        fs.renameSync(this.logPath, archivePath);
        fs.writeFileSync(this.logPath, '');
        this.lastSize = 0;
      }
    } catch {}

    // Atomic append with retry (cross-process safe)
    let written = false;
    for (let attempt = 0; attempt < 5 && !written; attempt++) {
      let release;
      try {
        release = lockfile.lockSync(this.logPath, { stale: 5000 });
        fs.appendFileSync(this.logPath, line);
        written = true;
      } catch (err) {
        if (err.code === 'ELOCKED' && attempt < 4) {
          // brief wait before retry
          const start = Date.now();
          while (Date.now() - start < 20) {}
        } else {
          console.error('[EventBus] Failed to write event:', err.message);
          break;
        }
      } finally {
        if (release) try { release(); } catch {}
      }
    }

    // In-memory pub/sub (skip Node's special 'error' event to avoid uncaught exception)
    if (type !== 'error') {
      super.emit(type, event);
    }
    super.emit('*', event);

    return event;
  }

  /**
   * Start watching events.log for external writes
   * Uses fs.watch + polling fallback (macOS fs.watch is unreliable for appends)
   */
  startWatching() {
    if (this.watcher || this.pollTimer) return;

    try {
      this.lastSize = fs.statSync(this.logPath).size;
    } catch {
      this.lastSize = 0;
    }

    const checkForNew = () => {
      try {
        const stat = fs.statSync(this.logPath);

        // Handle file truncation/rotation
        if (stat.size < this.lastSize) {
          this.lastSize = 0;
        }

        if (stat.size <= this.lastSize) return;

        const fd = fs.openSync(this.logPath, 'r');
        const buf = Buffer.alloc(stat.size - this.lastSize);
        fs.readSync(fd, buf, 0, buf.length, this.lastSize);
        fs.closeSync(fd);

        this.lastSize = stat.size;

        const lines = buf.toString('utf8').trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            super.emit(event.type, event);
            super.emit('*', event);
          } catch {}
        }
      } catch {}
    };

    // fs.watch for immediate notification (when it works)
    try {
      this.watcher = fs.watch(this.logPath, (eventType) => {
        if (eventType === 'change') checkForNew();
      });
    } catch {}

    // Polling fallback every 500ms (handles macOS fs.watch unreliability)
    this.pollTimer = setInterval(checkForNew, 500);
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  recent(limit = 50, type = null) {
    // Read from current + historical segments until we have enough
    const dir = path.dirname(this.logPath);
    const files = [this.logPath];

    try {
      const segments = fs.readdirSync(dir)
        .filter(f => /^events-\d+\.log$/.test(f))
        .sort()
        .reverse() // newest segments first
        .map(f => path.join(dir, f));
      files.push(...segments);
    } catch {}

    let events = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        const parsed = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        // Prepend older events (files are iterated newest first, but within file order is oldest→newest)
        events = parsed.concat(events);
      } catch {}

      if (type) {
        const filtered = events.filter(e => e.type === type);
        if (filtered.length >= limit) {
          return filtered.slice(-limit);
        }
      } else if (events.length >= limit) {
        return events.slice(-limit);
      }
    }

    if (type) events = events.filter(e => e.type === type);
    return events.slice(-limit);
  }

  getSize() {
    try {
      return fs.statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }

  readFrom(offset) {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size <= offset) return [];

      const fd = fs.openSync(this.logPath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);

      return buf.toString('utf8').trim().split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

module.exports = EventBus;
