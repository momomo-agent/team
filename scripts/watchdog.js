#!/usr/bin/env node
/**
 * Team Watchdog — auto-restart dead daemons
 * Usage: node watchdog.js [--interval 300]
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DEVTEAM_ROOT = path.join(__dirname, '..');
const CHECK_INTERVAL = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '300') * 1000;

const SEARCH_DIRS = [
  path.join(process.env.HOME, 'LOCAL/momo-agent/projects'),
  path.join(process.env.HOME, 'clawd/memory'),
];

function findProjects() {
  const projects = [];
  for (const dir of SEARCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const teamConfig = path.join(dir, entry, '.team/config.json');
      if (fs.existsSync(teamConfig)) projects.push(path.join(dir, entry));
    }
  }
  return projects;
}

function isDaemonAlive(projectDir) {
  const pidPath = path.join(projectDir, '.team/daemon.pid');
  if (!fs.existsSync(pidPath)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wasRunning(projectDir) {
  // Only restart if it was previously started (pid file exists, even stale)
  return fs.existsSync(path.join(projectDir, '.team/daemon.pid'));
}

function restartDaemon(projectDir) {
  const pidPath = path.join(projectDir, '.team/daemon.pid');
  try { fs.unlinkSync(pidPath); } catch {}

  const daemonPath = path.join(DEVTEAM_ROOT, 'agents/daemon.js');
  const logPath = path.join(projectDir, '.team/daemon.log');
  const out = fs.openSync(logPath, 'a');

  const daemon = spawn('node', [daemonPath, projectDir, '--devs=3'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  daemon.unref();
  fs.writeFileSync(pidPath, daemon.pid.toString());
  return daemon.pid;
}

function check() {
  const projects = findProjects();
  const ts = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
  for (const p of projects) {
    if (!isDaemonAlive(p) && wasRunning(p)) {
      const pid = restartDaemon(p);
      console.log(`[${ts}] Restarted ${path.basename(p)} (new pid: ${pid})`);
    }
  }
}

// Write own pid
fs.writeFileSync(path.join(DEVTEAM_ROOT, '.watchdog.pid'), process.pid.toString());

console.log(`Watchdog started (pid: ${process.pid}, interval: ${CHECK_INTERVAL/1000}s)`);
check();
setInterval(check, CHECK_INTERVAL);
