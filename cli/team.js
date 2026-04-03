#!/usr/bin/env node
/**
 * DevTeam CLI - AI Development Team Management
 *
 * Commands (from DESIGN.md):
 *   team init <dir>                    Initialize project
 *   team status                        Overview (match% + milestones + agents)
 *   team vision show                   Show vision
 *   team prd show                      Show PRD
 *   team arch show                     Show architecture
 *   team milestone list                All milestones + status
 *   team milestone show <id>           Details (DBB + design + tasks + review)
 *   team milestone create <name>       Create milestone
 *   team task list [--milestone <id>] [--status <s>]
 *   team task create <title> <desc> [--milestone <id>]
 *   team task update <id> <json>
 *   team task show <id>
 *   team start [--devs N]             Start daemon
 *   team stop                         Stop daemon
 *   team agents                       Agent status
 *   team gaps [--level L0|L1|L2|L3]   View gaps
 *   team check <milestone-id>         Manual triple check
 *   team cr list                      CR list
 *   team cr show <id>                 CR details
 *   team cr approve <id>              Approve CR
 *   team cr reject <id>               Reject CR
 *   team web [--port 3000]            Start dashboard
 */

const fs = require('fs');
const path = require('path');

const command = process.argv[2];
const subcommand = process.argv[3];
const args = process.argv.slice(3);

const DEVTEAM_ROOT = path.join(__dirname, '..');

// --- Helpers ---

function getProjectDir() {
  // Walk up from cwd to find .team/config.json
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.team/config.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function requireProject() {
  const dir = getProjectDir();
  if (!fs.existsSync(path.join(dir, '.team/config.json'))) {
    console.error('Error: Not in a DevTeam project. Run "team init <dir>" first.');
    process.exit(1);
  }
  return dir;
}

function readJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

function readFile(filepath) {
  try { return fs.readFileSync(filepath, 'utf8'); }
  catch { return null; }
}

function getTaskManager(projectDir) {
  const TaskManager = require(path.join(DEVTEAM_ROOT, 'lib/task-manager.js'));
  return new TaskManager(projectDir);
}

function findArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

// --- Commands ---

function init(dirName) {
  if (!dirName) {
    console.error('Usage: team init <dir>');
    process.exit(1);
  }

  const projectDir = path.resolve(dirName);

  if (fs.existsSync(path.join(projectDir, '.team/config.json'))) {
    console.error(`Error: ${dirName} is already a DevTeam project`);
    process.exit(1);
  }

  // Create full directory structure from DESIGN.md
  const dirs = [
    '.team',
    '.team/gaps',
    '.team/gaps/milestones',
    '.team/change-requests',
    '.team/milestones',
    '.team/tasks',
    'src'
  ];

  for (const dir of dirs) {
    fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
  }

  // Load default config and merge with project-specific fields
  const defaultConfigPath = path.join(DEVTEAM_ROOT, 'configs/default.json');
  let defaultConfig = {};
  try { defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8')); } catch {}

  const config = Object.assign({}, defaultConfig, {
    name: path.basename(projectDir),
    created: new Date().toISOString(),
    devteamVersion: '2.0'
  });
  fs.writeFileSync(path.join(projectDir, '.team/config.json'), JSON.stringify(config, null, 2));

  // Create kanban
  const kanban = { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
  fs.writeFileSync(path.join(projectDir, '.team/kanban.json'), JSON.stringify(kanban, null, 2));

  // Create milestones index
  fs.writeFileSync(path.join(projectDir, '.team/milestones/milestones.json'), JSON.stringify({ milestones: [] }, null, 2));

  // Create template files if they don't exist
  const templates = {
    'VISION.md': '# Vision\n\n## Why\n\n## Problem\n\n## End State\n\n',
    'PRD.md': '# Product Requirements\n\n## Features\n\n## User Stories\n\n',
    'EXPECTED_DBB.md': '# Expected DBB (验收标准)\n\n## Core Flows\n\n## Quality Gates\n\n',
    'ARCHITECTURE.md': '# Architecture\n\n'
  };

  for (const [file, content] of Object.entries(templates)) {
    const fp = path.join(projectDir, file);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, content);
    }
  }

  console.log(`Project initialized: ${projectDir}`);
  console.log(`  cd ${dirName}`);
  console.log(`  # Edit VISION.md, PRD.md, EXPECTED_DBB.md`);
  console.log(`  team start`);
}

function status() {
  const dir = requireProject();
  const config = readJSON(path.join(dir, '.team/config.json'));

  console.log(`\n  Project: ${config.name}`);
  console.log(`  Created: ${config.created}\n`);

  // Gaps / Match percentages
  const gaps = {};
  for (const level of ['vision', 'prd', 'dbb', 'architecture']) {
    const g = readJSON(path.join(dir, `.team/gaps/${level}.json`));
    gaps[level] = g ? (g.match != null ? g.match : (g.coverage != null ? g.coverage : '-')) : '-';
  }

  console.log('  Match:');
  console.log(`    L0 Vision:       ${gaps.vision}%`);
  console.log(`    L1 PRD:          ${gaps.prd}%`);
  console.log(`    DBB:             ${gaps.dbb}%`);
  console.log(`    L2 Architecture: ${gaps.architecture}%`);

  // Milestones
  const tm = getTaskManager(dir);
  const milestones = tm.listMilestones();
  console.log(`\n  Milestones: ${milestones.length}`);
  for (const ms of milestones) {
    const icon = ms.status === 'completed' ? '●' : ms.status === 'active' ? '◉' : '○';
    console.log(`    ${icon} ${ms.id} ${ms.name} [${ms.status}] ${ms.progress}% (${ms.doneCount}/${ms.taskCount})`);
  }

  // Kanban summary
  const kanban = readJSON(path.join(dir, '.team/kanban.json')) || {};
  const total = (kanban.todo || []).length + (kanban.inProgress || []).length +
    (kanban.review || []).length + (kanban.testing || []).length + (kanban.done || []).length;
  const completion = total > 0 ? Math.round(((kanban.done || []).length / total) * 100) : 0;

  console.log(`\n  Tasks: ${total} total, ${completion}% complete`);
  console.log(`    Todo: ${(kanban.todo || []).length}  InProgress: ${(kanban.inProgress || []).length}  Review: ${(kanban.review || []).length}  Testing: ${(kanban.testing || []).length}  Done: ${(kanban.done || []).length}`);

  // Daemon
  const pidPath = path.join(dir, '.team/daemon.pid');
  let daemonRunning = false;
  if (fs.existsSync(pidPath)) {
    const pid = readFile(pidPath).trim();
    try { process.kill(parseInt(pid), 0); daemonRunning = true; } catch {}
  }
  console.log(`\n  Daemon: ${daemonRunning ? 'running' : 'stopped'}`);

  // Agent status
  const agentStatus = readJSON(path.join(dir, '.team/agent-status.json'));
  if (agentStatus) {
    const running = Object.entries(agentStatus).filter(([, v]) => v.status === 'running');
    if (running.length > 0) {
      console.log(`  Active agents: ${running.map(([k]) => k).join(', ')}`);
    }
  }
  console.log('');
}

function showDoc(docName) {
  const dir = requireProject();
  const fileMap = { vision: 'VISION.md', prd: 'PRD.md', arch: 'ARCHITECTURE.md' };
  const file = fileMap[docName];
  if (!file) {
    console.error(`Unknown doc: ${docName}. Use: vision, prd, arch`);
    return;
  }
  const content = readFile(path.join(dir, file));
  if (content) {
    console.log(content);
  } else {
    console.error(`${file} not found`);
  }
}

function milestoneList() {
  const dir = requireProject();
  const tm = getTaskManager(dir);
  const milestones = tm.listMilestones();

  if (milestones.length === 0) {
    console.log('No milestones yet.');
    return;
  }

  console.log('\n  Milestones:\n');
  for (const ms of milestones) {
    const icon = ms.status === 'completed' ? '●' : ms.status === 'active' ? '◉' : '○';
    const bar = '█'.repeat(Math.floor(ms.progress / 10)) + '░'.repeat(10 - Math.floor(ms.progress / 10));
    console.log(`  ${icon} ${ms.id} ${ms.name}`);
    console.log(`    Status: ${ms.status}  Progress: [${bar}] ${ms.progress}% (${ms.doneCount}/${ms.taskCount})`);
  }
  console.log('');
}

function milestoneShow(id) {
  if (!id) { console.error('Usage: team milestone show <id>'); return; }
  const dir = requireProject();
  const tm = getTaskManager(dir);
  const detail = tm.showMilestone(id);
  if (!detail) return;

  console.log(`\n  Milestone: ${detail.id} — ${detail.name} [${detail.status}]\n`);

  if (detail.overview) {
    console.log('  --- Overview ---');
    console.log(detail.overview);
  }
  if (detail.dbb) {
    console.log('  --- DBB ---');
    console.log(detail.dbb);
  }
  if (detail.design) {
    console.log('  --- Design ---');
    console.log(detail.design);
  }

  if (detail.taskDetails && detail.taskDetails.length > 0) {
    console.log('  --- Tasks ---');
    for (const t of detail.taskDetails) {
      console.log(`    [${t.status}] ${t.id}: ${t.title} (${t.priority}) ${t.hasDesign ? '[designed]' : ''}`);
    }
  }

  if (detail.review && Object.keys(detail.review).length > 0) {
    console.log('\n  --- Review ---');
    for (const [name, content] of Object.entries(detail.review)) {
      console.log(`\n  >> ${name}:`);
      console.log(content);
    }
  }
  console.log('');
}

function milestoneCreate(name) {
  if (!name) { console.error('Usage: team milestone create <name>'); return; }
  const dir = requireProject();
  const tm = getTaskManager(dir);
  tm.createMilestone(name);
}

function taskList() {
  const dir = requireProject();
  const tm = getTaskManager(dir);
  const milestone = findArg('--milestone');
  const status = findArg('--status');
  const tasks = tm.listTasks({ milestone, status });

  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  console.log('\n  Tasks:\n');
  for (const t of tasks) {
    const design = t.hasDesign ? ' [designed]' : '';
    const ms = t.milestoneId ? ` (${t.milestoneId})` : '';
    const assignee = t.assignee ? ` @${t.assignee}` : '';
    console.log(`  [${t.status}] ${t.id}: ${t.title} ${t.priority}${ms}${design}${assignee}`);
  }
  console.log('');
}

function taskCreate() {
  const title = process.argv[4];
  const desc = process.argv[5] || '';
  if (!title) { console.error('Usage: team task create <title> <desc> [--milestone <id>]'); return; }
  const dir = requireProject();
  const tm = getTaskManager(dir);
  const milestone = findArg('--milestone');
  tm.createTask(title, desc, { milestone });
}

function taskUpdate() {
  const taskId = process.argv[4];
  const jsonStr = process.argv[5];
  if (!taskId || !jsonStr) { console.error('Usage: team task update <id> <json>'); return; }
  const dir = requireProject();
  const tm = getTaskManager(dir);
  try {
    const updates = JSON.parse(jsonStr);
    tm.updateTask(taskId, updates);
  } catch (e) {
    console.error('Invalid JSON:', e.message);
  }
}

function taskShow() {
  const taskId = process.argv[4];
  if (!taskId) { console.error('Usage: team task show <id>'); return; }
  const dir = requireProject();
  const tm = getTaskManager(dir);
  const detail = tm.showTask(taskId);
  if (!detail) return;

  console.log(`\n  Task: ${detail.id} — ${detail.title}`);
  console.log(`  Status: ${detail.status}  Priority: ${detail.priority}  Milestone: ${detail.milestoneId || '-'}`);
  console.log(`  Assignee: ${detail.assignee || '-'}  HasDesign: ${detail.hasDesign}`);
  console.log(`  Description: ${detail.description}`);

  if (detail.design) {
    console.log('\n  --- Design ---');
    console.log(detail.design);
  }
  if (detail.progress) {
    console.log('\n  --- Progress ---');
    console.log(detail.progress);
  }
  if (detail.testResult) {
    console.log('\n  --- Test Result ---');
    console.log(detail.testResult);
  }
  console.log('');
}

function startDaemon() {
  const dir = requireProject();
  const pidPath = path.join(dir, '.team/daemon.pid');

  // Check if already running
  if (fs.existsSync(pidPath)) {
    const pid = readFile(pidPath).trim();
    try {
      process.kill(parseInt(pid), 0);
      console.log(`Daemon already running (pid: ${pid})`);
      return;
    } catch {
      // Stale PID file
      fs.unlinkSync(pidPath);
    }
  }

  const daemonPath = path.join(DEVTEAM_ROOT, 'agents/daemon.js');
  const { spawn } = require('child_process');

  const devs = findArg('--devs') || '3';
  const logPath = path.join(dir, '.team/daemon.log');

  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  const daemon = spawn('node', [daemonPath, dir, `--devs=${devs}`], {
    detached: true,
    stdio: ['ignore', out, err]
  });

  daemon.unref();

  fs.writeFileSync(pidPath, daemon.pid.toString());
  console.log(`Daemon started (pid: ${daemon.pid}, devs: ${devs})`);
  console.log(`Log: ${logPath}`);
}

function stopDaemon() {
  const dir = requireProject();
  const pidPath = path.join(dir, '.team/daemon.pid');

  if (!fs.existsSync(pidPath)) {
    console.log('Daemon is not running');
    return;
  }

  const pid = readFile(pidPath).trim();
  try {
    process.kill(parseInt(pid), 'SIGTERM');
    fs.unlinkSync(pidPath);
    console.log('Daemon stopped');
  } catch (err) {
    console.error('Error stopping daemon:', err.message);
    try { fs.unlinkSync(pidPath); } catch {}
  }
}

function agents() {
  const dir = requireProject();
  const agentStatus = readJSON(path.join(dir, '.team/agent-status.json'));

  if (!agentStatus || Object.keys(agentStatus).length === 0) {
    console.log('No agent activity recorded.');
    return;
  }

  console.log('\n  Agent Status:\n');
  for (const [name, info] of Object.entries(agentStatus)) {
    const dot = info.status === 'running' ? '🟢' : info.status === 'error' ? '🔴' : '⚪';
    const task = info.currentTask ? ` — ${info.currentTask}` : '';
    const time = info.lastRun ? ` (${info.lastRun})` : '';
    console.log(`  ${dot} ${name}: ${info.status}${task}${time}`);
  }
  console.log('');
}

function showGaps() {
  const dir = requireProject();
  const level = findArg('--level');

  console.log('\n  Gaps:\n');

  const gapFiles = {
    L0: 'vision.json',
    L1: 'prd.json',
    DBB: 'dbb.json',
    L2: 'architecture.json'
  };

  const levels = level ? { [level]: gapFiles[level] } : gapFiles;

  for (const [lv, file] of Object.entries(levels)) {
    if (!file) continue;
    const data = readJSON(path.join(dir, '.team/gaps', file));
    if (data) {
      console.log(`  ${lv} (${file}): ${data.match}% match`);
      if (data.gaps && Array.isArray(data.gaps)) {
        for (const gap of data.gaps) {
          if (typeof gap === 'string') {
            console.log(`    - ${gap}`);
          } else if (gap.description) {
            console.log(`    - ${gap.description} [${gap.status || ''}]`);
          } else if (gap.module) {
            console.log(`    - ${gap.module}: ${gap.status} (${gap.coverage || ''})`);
          } else if (gap.feature) {
            console.log(`    - ${gap.feature}: ${gap.status}`);
          }
        }
      }
      console.log('');
    }
  }

  // L3 milestone gaps
  if (!level || level === 'L3') {
    const msGapsDir = path.join(dir, '.team/gaps/milestones');
    if (fs.existsSync(msGapsDir)) {
      try {
        const files = fs.readdirSync(msGapsDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          const data = readJSON(path.join(msGapsDir, f));
          if (data) {
            console.log(`  L3 ${f}: ${data.match}% match (${data.milestoneId || ''})`);
            if (data.criteria) {
              for (const c of data.criteria) {
                const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️';
                console.log(`    ${icon} ${c.criterion}`);
              }
            }
            console.log('');
          }
        }
      } catch {}
    }
  }
}

function check(milestoneId) {
  if (!milestoneId) { console.error('Usage: team check <milestone-id>'); return; }
  const dir = requireProject();

  console.log(`Running triple check for milestone ${milestoneId}...`);

  const { execSync } = require('child_process');
  const runner = path.join(DEVTEAM_ROOT, 'agents/runner.js');

  const monitors = ['vision_monitor', 'prd_monitor', 'dbb_monitor', 'arch_monitor'];
  // Run sequentially in CLI context (parallel would need daemon)
  for (const monitor of monitors) {
    console.log(`\n  Running ${monitor}...`);
    try {
      execSync(`node "${runner}" ${monitor} "${dir}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`  ${monitor} failed: ${err.message}`);
    }
  }

  console.log('\nCheck complete. View results: team milestone show ' + milestoneId);
}

function crList() {
  const dir = requireProject();
  const crDir = path.join(dir, '.team/change-requests');

  if (!fs.existsSync(crDir)) {
    console.log('No change requests.');
    return;
  }

  let files;
  try {
    files = fs.readdirSync(crDir).filter(f => f.endsWith('.json'));
  } catch {
    console.log('No change requests.');
    return;
  }

  if (files.length === 0) {
    console.log('No change requests.');
    return;
  }

  console.log('\n  Change Requests:\n');
  for (const f of files) {
    const cr = readJSON(path.join(crDir, f));
    if (cr) {
      const icon = cr.status === 'approved' ? '✅' : cr.status === 'rejected' ? '❌' : '⏳';
      console.log(`  ${icon} ${f.replace('.json', '')}: [${cr.status}] from=${cr.from} toLevel=${cr.toLevel || cr.to}`);
      console.log(`     ${cr.reason}`);
    }
  }
  console.log('');
}

function crShow(id) {
  if (!id) { console.error('Usage: team cr show <id>'); return; }
  const dir = requireProject();
  const cr = readJSON(path.join(dir, `.team/change-requests/${id}.json`));
  if (!cr) { console.error(`CR ${id} not found`); return; }
  console.log(JSON.stringify(cr, null, 2));
}

function crDecision(id, decision) {
  if (!id) { console.error(`Usage: team cr ${decision} <id>`); return; }
  const dir = requireProject();
  const crPath = path.join(dir, `.team/change-requests/${id}.json`);
  const cr = readJSON(crPath);
  if (!cr) { console.error(`CR ${id} not found`); return; }

  cr.status = decision === 'approve' ? 'approved' : 'rejected';
  cr.reviewedAt = new Date().toISOString();
  cr.reviewedBy = 'user';
  fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
  console.log(`CR ${id} ${cr.status}`);
}

function web() {
  const dir = requireProject();
  const serverPath = path.join(DEVTEAM_ROOT, 'web/server.js');
  const { spawn } = require('child_process');

  const port = findArg('--port') || '3000';

  const server = spawn('node', [serverPath, dir, port], { stdio: 'inherit' });

  console.log(`Dashboard: http://localhost:${port}`);
  console.log('Press Ctrl+C to stop');

  process.on('SIGINT', () => { server.kill(); process.exit(0); });
}

// --- Command Router ---

switch (command) {
  case 'init':
    init(args[0]);
    break;

  case 'status':
    status();
    break;

  case 'vision':
    if (subcommand === 'show') showDoc('vision');
    else console.log('Usage: team vision show');
    break;

  case 'prd':
    if (subcommand === 'show') showDoc('prd');
    else console.log('Usage: team prd show');
    break;

  case 'arch':
    if (subcommand === 'show') showDoc('arch');
    else console.log('Usage: team arch show');
    break;

  case 'milestone':
    switch (subcommand) {
      case 'list': milestoneList(); break;
      case 'show': milestoneShow(process.argv[4]); break;
      case 'create': milestoneCreate(process.argv[4]); break;
      default: console.log('Usage: team milestone <list|show|create>');
    }
    break;

  case 'task':
    switch (subcommand) {
      case 'list': taskList(); break;
      case 'create': taskCreate(); break;
      case 'update': taskUpdate(); break;
      case 'show': taskShow(); break;
      default: console.log('Usage: team task <list|create|update|show>');
    }
    break;

  case 'start':
    startDaemon();
    break;

  case 'stop':
    stopDaemon();
    break;

  case 'agents':
    agents();
    break;

  case 'gaps':
    showGaps();
    break;

  case 'check':
    check(args[0]);
    break;

  case 'cr':
    switch (subcommand) {
      case 'list': crList(); break;
      case 'show': crShow(process.argv[4]); break;
      case 'approve': crDecision(process.argv[4], 'approve'); break;
      case 'reject': crDecision(process.argv[4], 'reject'); break;
      default: console.log('Usage: team cr <list|show|approve|reject>');
    }
    break;

  case 'web':
    web();
    break;

  default:
    console.log('DevTeam CLI v2.0\n');
    console.log('Project:');
    console.log('  team init <dir>                   Initialize project');
    console.log('  team status                       Project overview');
    console.log('');
    console.log('Documents:');
    console.log('  team vision show                  Show vision');
    console.log('  team prd show                     Show PRD');
    console.log('  team arch show                    Show architecture');
    console.log('');
    console.log('Milestones:');
    console.log('  team milestone list               List milestones');
    console.log('  team milestone show <id>          Milestone details');
    console.log('  team milestone create <name>      Create milestone');
    console.log('');
    console.log('Tasks:');
    console.log('  team task list [--milestone <id>] [--status <s>]');
    console.log('  team task create <title> <desc> [--milestone <id>]');
    console.log('  team task update <id> <json>');
    console.log('  team task show <id>');
    console.log('');
    console.log('Agents:');
    console.log('  team start [--devs N]             Start daemon');
    console.log('  team stop                         Stop daemon');
    console.log('  team agents                       Agent status');
    console.log('');
    console.log('Monitoring:');
    console.log('  team gaps [--level L0|L1|L2|L3]   View gaps');
    console.log('  team check <milestone-id>         Manual triple check');
    console.log('');
    console.log('Change Requests:');
    console.log('  team cr list                      List CRs');
    console.log('  team cr show <id>                 CR details');
    console.log('  team cr approve <id>              Approve CR');
    console.log('  team cr reject <id>               Reject CR');
    console.log('');
    console.log('Dashboard:');
    console.log('  team web [--port 3000]            Start web dashboard');
}
