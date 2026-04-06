#!/usr/bin/env node
/**
 * Task Manager - Create and manage tasks with group support
 *
 * Commands:
 *   create <title> <desc> [--group <id>]  Create a task (--milestone still works)
 *   update <taskId> <json>                     Update a task
 *   list [--group <id>] [--status <s>]     List tasks (--milestone still works)
 *   show <taskId>                              Show task details
 *   milestone-create <name>                    Create a group (milestone alias)
 *   milestone-list                             List groups (milestone alias)
 *   milestone-show <id>                        Show group details (milestone alias)
 */

const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const EventBus = require('./event-bus');

class TaskManager {
  constructor(projectDir, daemon = null) {
    this.projectDir = projectDir;
    this.daemon = daemon;
    this.tasksDir = path.join(projectDir, '.team/tasks');
    // Group system: "milestones" is the default group label (configurable)
    const config = daemon && daemon.config || {};
    this.groupLabel = (config.groups && config.groups.label) || 'milestones';
    this.groupsDir = path.join(projectDir, '.team', this.groupLabel);
    this.groupsPath = path.join(this.groupsDir, this.groupLabel + '.json');
    // Backward compat aliases
    this.milestonesDir = this.groupsDir;
    this.milestonesPath = this.groupsPath;
    this.kanbanPath = path.join(projectDir, '.team/kanban.json');
    this.eventBus = daemon && daemon.eventBus ? daemon.eventBus : new EventBus(projectDir);
  }

  ensureDirs() {
    for (const dir of [this.tasksDir, this.groupsDir, path.join(this.projectDir, '.team/gaps', this.groupLabel)]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // --- Kanban ---

  getKanban() {
    // Single source of truth: scan task.json files
    const kanban = { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
    try {
      const dirs = fs.readdirSync(this.tasksDir);
      for (const tid of dirs) {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(this.tasksDir, tid, 'task.json'), 'utf8'));
          const col = t.status;
          if (kanban[col]) kanban[col].push(tid);
        } catch {}
      }
    } catch {}
    return kanban;
  }

  saveKanban(kanban) {
    // no-op: kanban is derived from task.json files
    if (this.daemon) this.daemon.emit('kanban_updated', kanban);
  }

  updateKanban(taskId, newStatus) {
    // CAS: update task.json status with lock to prevent concurrent claims
    const taskPath = path.join(this.tasksDir, taskId, 'task.json');
    let release;
    try {
      release = lockfile.lockSync(taskPath, { retries: 5, stale: 10000 });
      const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));

      // Prevent double-claim
      if (newStatus === 'inProgress' && task.status !== 'todo') {
        throw new Error(`Task ${taskId} cannot be claimed (current status: ${task.status})`);
      }

      task.status = newStatus;
      task.updated = new Date().toISOString();
      fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
    } finally {
      if (release) release();
    }
  }

  // --- Tasks ---

  createTask(title, description, opts = {}) {
    this.ensureDirs();

    const taskId = `task-${Date.now()}`;
    const taskDir = path.join(this.tasksDir, taskId);

    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });

    const task = {
      id: taskId,
      title: title,
      description: description || '',
      status: 'todo',
      priority: opts.priority || 'P1',
      assignee: null,
      blockedBy: opts.blockedBy || [],
      groupId: opts.group || opts.milestone || null, // group is new, milestone for compat
      hasDesign: false,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };

    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
    fs.writeFileSync(path.join(taskDir, 'progress.md'), `# ${title}\n\n## Progress\n\n`);

    // Emit event
    this.eventBus.emit('task_created', null, { taskId, title, priority: task.priority, group: task.groupId });

    // Add task to group if specified
    if (opts.group || opts.milestone) {
      this.addTaskToMilestone(opts.group || opts.milestone, taskId);
    }

    console.log(`Task created: ${taskId}`);
    return taskId;
  }

  updateTask(taskId, updates) {
    const taskDir = path.join(this.tasksDir, taskId);
    const taskPath = path.join(taskDir, 'task.json');

    if (!fs.existsSync(taskPath)) {
      console.error(`Task ${taskId} not found`);
      return null;
    }

    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    const oldStatus = task.status;

    Object.assign(task, updates, { updated: new Date().toISOString() });
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));

    // Emit status change event
    if (updates.status && updates.status !== oldStatus) {
      this.eventBus.emit('task_status', task.assignee, { taskId, from: oldStatus, to: updates.status, title: task.title });
    }

    console.log(`Task updated: ${taskId}`);
    return task;
  }

  getTask(taskId) {
    const taskPath = path.join(this.tasksDir, taskId, 'task.json');
    try {
      return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    } catch {
      return null;
    }
  }

  listTasks(opts = {}) {
    this.ensureDirs();
    const tasks = [];

    let taskDirs;
    try {
      taskDirs = fs.readdirSync(this.tasksDir).filter(d => d.startsWith('task-'));
    } catch {
      return [];
    }

    for (const dir of taskDirs) {
      const taskPath = path.join(this.tasksDir, dir, 'task.json');
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));

        // Support both --group and --milestone (backward compat)
        const taskGroup = task.groupId || task.milestoneId;
        if ((opts.group || opts.milestone) && taskGroup !== (opts.group || opts.milestone)) continue;
        if (opts.status && task.status !== opts.status) continue;

        tasks.push(task);
      } catch {}
    }

    return tasks.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  }

  showTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found`);
      return null;
    }

    const taskDir = path.join(this.tasksDir, taskId);
    const result = { ...task };

    // Load associated files
    const designPath = path.join(taskDir, 'design.md');
    if (fs.existsSync(designPath)) {
      result.design = fs.readFileSync(designPath, 'utf8');
    }

    const progressPath = path.join(taskDir, 'progress.md');
    if (fs.existsSync(progressPath)) {
      result.progress = fs.readFileSync(progressPath, 'utf8');
    }

    const testPath = path.join(taskDir, 'test-result.md');
    if (fs.existsSync(testPath)) {
      result.testResult = fs.readFileSync(testPath, 'utf8');
    }

    return result;
  }

  // --- Milestones ---

  getMilestones() {
    try {
      return JSON.parse(fs.readFileSync(this.milestonesPath, 'utf8'));
    } catch {
      return { milestones: [] };
    }
  }

  // --- Task Claiming ---

  /**
   * Check if task can be claimed (hard constraints)
   * 被 blocked 的任务不能被 claim
   */
  canClaimTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) return false;
    
    // 被 blocked 的任务不能 claim
    if (task.status === 'blocked') return false;
    
    // 有 blockedBy 的任务不能 claim
    if (task.blockedBy && task.blockedBy.length > 0) return false;
    
    // Task with existing assignee cannot be claimed by others
    if (task.assignee && task.status === 'inProgress') return false;
    
    // 任务状态必须是 todo 或 inProgress（重新 claim）
    if (!['todo', 'inProgress'].includes(task.status)) return false;
    
    return true;
  }

  // --- Change Requests (CR) ---

  createCR(from, reason, affectedTasks = [], opts = {}) {
    const crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) {
      fs.mkdirSync(crDir, { recursive: true });
    }

    const crId = `cr-${Date.now()}`;
    const title = opts.title || reason.substring(0, 100);
    const description = opts.description || reason;
    
    const cr = {
      id: crId,
      from: from,
      reason: reason,
      title: title,
      description: description,
      affectedTasks: affectedTasks,
      status: 'pending',
      created: new Date().toISOString(),
      resolved: null
    };

    fs.writeFileSync(path.join(crDir, `${crId}.json`), JSON.stringify(cr, null, 2));
    console.log(`CR created: ${crId}`);
    
    // 发送事件
    if (this.daemon) {
      this.daemon.emit('cr_changed', { action: 'created', cr });
    }

    // Task 2: Check if this is a blocker CR (affects multiple tasks)
    if (affectedTasks.length >= 2) {
      console.log(`BLOCKER CR detected: ${crId} affects ${affectedTasks.length} tasks`);
      cr.isBlocker = true;
      fs.writeFileSync(path.join(crDir, `${crId}.json`), JSON.stringify(cr, null, 2));

      // Block affected tasks
      for (const taskId of affectedTasks) {
        try {
          const task = this.getTask(taskId);
          if (task && task.status !== 'done' && task.status !== 'blocked') {
            this.updateTask(taskId, { 
              status: 'blocked',
              blockedBy: [...(task.blockedBy || []), crId]
            });
            console.log(`Task ${taskId} blocked by CR ${crId}`);
          }
        } catch (err) {
          console.error(`Failed to block task ${taskId}:`, err.message);
        }
      }
    }

    return crId;
  }

  resolveCR(crId, resolution) {
    const crDir = path.join(this.projectDir, '.team/change-requests');
    const crPath = path.join(crDir, `${crId}.json`);

    if (!fs.existsSync(crPath)) {
      console.error(`CR ${crId} not found`);
      return null;
    }

    const cr = JSON.parse(fs.readFileSync(crPath, 'utf8'));
    cr.status = 'resolved';
    cr.resolved = new Date().toISOString();
    cr.resolution = resolution;

    fs.writeFileSync(crPath, JSON.stringify(cr, null, 2));
    console.log(`CR resolved: ${crId}`);
    
    // 发送事件
    if (this.daemon) {
      this.daemon.emit('cr_changed', { action: 'resolved', cr });
    }

    // Task 2: Unblock affected tasks if this was a blocker CR
    if (cr.isBlocker && cr.affectedTasks) {
      for (const taskId of cr.affectedTasks) {
        try {
          const task = this.getTask(taskId);
          if (task && task.status === 'blocked') {
            const newBlockedBy = (task.blockedBy || []).filter(id => id !== crId);
            // Only unblock if no other CRs are blocking
            if (newBlockedBy.length === 0) {
              this.updateTask(taskId, { 
                status: 'todo',
                blockedBy: newBlockedBy
              });
              console.log(`Task ${taskId} unblocked (CR ${crId} resolved)`);
            } else {
              this.updateTask(taskId, { blockedBy: newBlockedBy });
            }
          }
        } catch (err) {
          console.error(`Failed to unblock task ${taskId}:`, err.message);
        }
      }
    }

    return cr;
  }

  listCRs(opts = {}) {
    const crDir = path.join(this.projectDir, '.team/change-requests');
    if (!fs.existsSync(crDir)) return [];

    const crs = [];
    let crFiles;
    try {
      crFiles = fs.readdirSync(crDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    for (const file of crFiles) {
      try {
        const cr = JSON.parse(fs.readFileSync(path.join(crDir, file), 'utf8'));
        if (opts.status && cr.status !== opts.status) continue;
        crs.push(cr);
      } catch {}
    }

    return crs.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  }

  // --- Milestones ---

  getMilestones() {
    try {
      return JSON.parse(fs.readFileSync(this.milestonesPath, 'utf8'));
    } catch {
      return { milestones: [] };
    }
  }

  saveMilestones(data) {
    this.ensureDirs();
    fs.writeFileSync(this.milestonesPath, JSON.stringify(data, null, 2));
  }

  createMilestone(name) {
    this.ensureDirs();

    const data = this.getMilestones();
    const idx = data.milestones.length + 1;
    const id = `m${idx}`;

    // Create milestone directory structure
    const msDir = path.join(this.milestonesDir, id);
    const reviewDir = path.join(msDir, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });

    // Create overview.md
    fs.writeFileSync(
      path.join(msDir, 'overview.md'),
      `# Milestone ${id}: ${name}\n\n## Goals\n\n## Scope\n\n## Success Criteria\n\n`
    );

    // Create empty dbb.md and design.md (tech_lead will fill these)
    fs.writeFileSync(path.join(msDir, 'dbb.md'), `# ${name} - DBB (验收标准)\n\n`);
    fs.writeFileSync(path.join(msDir, 'design.md'), `# ${name} - Technical Design\n\n`);

    // Determine status: first milestone is active, rest are planned
    const hasActive = data.milestones.some(m => m.status === 'active');
    const status = hasActive ? 'planned' : 'active';

    const group = {
      id,
      name,
      status,
      tasks: [],
      created: new Date().toISOString()
    };

    data.milestones.push(group);
    this.saveMilestones(data);

    console.log(`Group created: ${id} (${name}) [${status}]`);
    return group;
  }

  addTaskToMilestone(milestoneId, taskId) {
    const data = this.getMilestones();
    const ms = data.milestones.find(m => m.id === milestoneId);
    if (!ms) {
      console.error(`Milestone ${milestoneId} not found`);
      return;
    }
    if (!ms.tasks.includes(taskId)) {
      ms.tasks.push(taskId);
      this.saveMilestones(data);
    }
  }

  showMilestone(milestoneId) {
    const data = this.getMilestones();
    const ms = data.milestones.find(m => m.id === milestoneId);
    if (!ms) {
      console.error(`Milestone ${milestoneId} not found`);
      return null;
    }

    const msDir = path.join(this.milestonesDir, milestoneId);
    const result = { ...ms };

    // Load associated files
    for (const file of ['overview.md', 'dbb.md', 'design.md']) {
      const fp = path.join(msDir, file);
      if (fs.existsSync(fp)) {
        result[file.replace('.md', '')] = fs.readFileSync(fp, 'utf8');
      }
    }

    // Load review files
    const reviewDir = path.join(msDir, 'review');
    if (fs.existsSync(reviewDir)) {
      result.review = {};
      try {
        for (const f of fs.readdirSync(reviewDir)) {
          if (f.endsWith('.md')) {
            result.review[f.replace('.md', '')] = fs.readFileSync(path.join(reviewDir, f), 'utf8');
          }
        }
      } catch {}
    }

    // Load task details
    result.taskDetails = ms.tasks.map(tid => this.getTask(tid)).filter(Boolean);

    return result;
  }

  listMilestones() {
    const data = this.getMilestones();
    return data.milestones.map(ms => {
      const tasks = ms.tasks.map(tid => this.getTask(tid)).filter(Boolean);
      const done = tasks.filter(t => t.status === 'done').length;
      return {
        ...ms,
        taskCount: ms.tasks.length,
        doneCount: done,
        progress: ms.tasks.length > 0 ? Math.round((done / ms.tasks.length) * 100) : 0
      };
    });
  }
}

// --- CLI Entry Point ---
if (require.main === module) {
  const action = process.argv[2];
  const projectDir = process.env.TEAM_PROJECT_DIR || process.cwd();
  const tm = new TaskManager(projectDir);

  switch (action) {
    case 'create': {
      const title = process.argv[3];
      const description = process.argv[4] || '';
      // Parse --group or --milestone (backward compat)
      const grpIdx = process.argv.indexOf('--group');
      const groupOrMsIdx = process.argv.indexOf('--milestone');
      const group = grpIdx !== -1 ? process.argv[grpIdx + 1] : (groupOrMsIdx !== -1 ? process.argv[groupOrMsIdx + 1] : null);
      const priIdx = process.argv.indexOf('--priority');
      const priority = priIdx !== -1 ? process.argv[priIdx + 1] : 'P1';
      tm.createTask(title, description, { group, milestone: group, priority });
      break;
    }

    case 'update': {
      const taskId = process.argv[3];
      const updates = JSON.parse(process.argv[4]);
      tm.updateTask(taskId, updates);
      break;
    }

    case 'list': {
      const grpIdx = process.argv.indexOf('--group');
      const groupOrMsIdx = process.argv.indexOf('--milestone');
      const group = grpIdx !== -1 ? process.argv[grpIdx + 1] : (groupOrMsIdx !== -1 ? process.argv[groupOrMsIdx + 1] : null);
      const stIdx = process.argv.indexOf('--status');
      const status = stIdx !== -1 ? process.argv[stIdx + 1] : null;
      const tasks = tm.listTasks({ group, milestone: group, status });
      console.log(JSON.stringify(tasks, null, 2));
      break;
    }

    case 'show': {
      const taskId = process.argv[3];
      const detail = tm.showTask(taskId);
      if (detail) console.log(JSON.stringify(detail, null, 2));
      break;
    }

    case 'milestone-create': {
      const name = process.argv[3];
      if (!name) { console.error('Usage: milestone-create <name>'); process.exit(1); }
      tm.createMilestone(name);
      break;
    }

    case 'milestone-list': {
      const milestones = tm.listMilestones();
      console.log(JSON.stringify(milestones, null, 2));
      break;
    }

    case 'milestone-show': {
      const msId = process.argv[3];
      if (!msId) { console.error('Usage: milestone-show <id>'); process.exit(1); }
      const detail = tm.showMilestone(msId);
      if (detail) console.log(JSON.stringify(detail, null, 2));
      break;
    }

    case 'cr-create': {
      const from = process.argv[3];
      const reason = process.argv[4];
      if (!from || !reason) { 
        console.error('Usage: cr-create <from> <reason> [--tasks task1,task2,...]'); 
        process.exit(1); 
      }
      const tasksIdx = process.argv.indexOf('--tasks');
      const affectedTasks = tasksIdx !== -1 ? process.argv[tasksIdx + 1].split(',') : [];
      tm.createCR(from, reason, affectedTasks);
      break;
    }

    case 'cr-resolve': {
      const crId = process.argv[3];
      const resolution = process.argv[4] || 'resolved';
      if (!crId) { console.error('Usage: cr-resolve <crId> [resolution]'); process.exit(1); }
      tm.resolveCR(crId, resolution);
      break;
    }

    case 'cr-list': {
      const stIdx = process.argv.indexOf('--status');
      const status = stIdx !== -1 ? process.argv[stIdx + 1] : null;
      const crs = tm.listCRs({ status });
      console.log(JSON.stringify(crs, null, 2));
      break;
    }

    case 'can-claim': {
      const taskId = process.argv[3];
      if (!taskId) { console.error('Usage: can-claim <taskId>'); process.exit(1); }
      const canClaim = tm.canClaimTask(taskId);
      console.log(JSON.stringify({ taskId, canClaim }, null, 2));
      break;
    }

    default:
      console.log('Usage: node task-manager.js <command> [args]');
      console.log('Commands:');
      console.log('  create <title> <desc> [--milestone <id>]');
      console.log('  update <taskId> <json>');
      console.log('  list [--milestone <id>] [--status <status>]');
      console.log('  show <taskId>');
      console.log('  milestone-create <name>');
      console.log('  milestone-list');
      console.log('  milestone-show <id>');
      console.log('  cr-create <from> <reason> [--tasks task1,task2,...]');
      console.log('  cr-resolve <crId> [resolution]');
      console.log('  cr-list [--status pending|resolved]');
  }
}

module.exports = TaskManager;
