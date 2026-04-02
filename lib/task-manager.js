#!/usr/bin/env node
/**
 * Task Manager - Create and manage tasks with milestone support
 *
 * Commands:
 *   create <title> <desc> [--milestone <id>]  Create a task
 *   update <taskId> <json>                     Update a task
 *   list [--milestone <id>] [--status <s>]     List tasks
 *   show <taskId>                              Show task details
 *   milestone-create <name>                    Create a milestone
 *   milestone-list                             List milestones
 *   milestone-show <id>                        Show milestone details
 */

const fs = require('fs');
const path = require('path');

class TaskManager {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.tasksDir = path.join(projectDir, '.team/tasks');
    this.milestonesDir = path.join(projectDir, '.team/milestones');
    this.kanbanPath = path.join(projectDir, '.team/kanban.json');
    this.milestonesPath = path.join(this.milestonesDir, 'milestones.json');
  }

  ensureDirs() {
    for (const dir of [this.tasksDir, this.milestonesDir, path.join(this.projectDir, '.team/gaps/milestones')]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // --- Kanban ---

  getKanban() {
    try {
      return JSON.parse(fs.readFileSync(this.kanbanPath, 'utf8'));
    } catch {
      return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
    }
  }

  saveKanban(kanban) {
    fs.writeFileSync(this.kanbanPath, JSON.stringify(kanban, null, 2));
  }

  updateKanban(taskId, newStatus) {
    const kanban = this.getKanban();
    const columns = ['todo', 'inProgress', 'blocked', 'review', 'testing', 'done'];

    // Remove from all columns
    for (const col of columns) {
      kanban[col] = (kanban[col] || []).filter(id => id !== taskId);
    }

    // Add to new column
    if (!kanban[newStatus]) kanban[newStatus] = [];
    kanban[newStatus].push(taskId);

    this.saveKanban(kanban);
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
      milestoneId: opts.milestone || null,
      hasDesign: false,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };

    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
    fs.writeFileSync(path.join(taskDir, 'progress.md'), `# ${title}\n\n## Progress\n\n`);

    // Update kanban
    this.updateKanban(taskId, 'todo');

    // Add task to milestone if specified
    if (opts.milestone) {
      this.addTaskToMilestone(opts.milestone, taskId);
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

    // Update kanban if status changed
    if (updates.status && updates.status !== oldStatus) {
      this.updateKanban(taskId, updates.status);
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

        if (opts.milestone && task.milestoneId !== opts.milestone) continue;
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

    const milestone = {
      id,
      name,
      status,
      tasks: [],
      created: new Date().toISOString()
    };

    data.milestones.push(milestone);
    this.saveMilestones(data);

    console.log(`Milestone created: ${id} (${name}) [${status}]`);
    return milestone;
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
      // Parse --milestone flag
      const msIdx = process.argv.indexOf('--milestone');
      const milestone = msIdx !== -1 ? process.argv[msIdx + 1] : null;
      const priIdx = process.argv.indexOf('--priority');
      const priority = priIdx !== -1 ? process.argv[priIdx + 1] : 'P1';
      tm.createTask(title, description, { milestone, priority });
      break;
    }

    case 'update': {
      const taskId = process.argv[3];
      const updates = JSON.parse(process.argv[4]);
      tm.updateTask(taskId, updates);
      break;
    }

    case 'list': {
      const msIdx = process.argv.indexOf('--milestone');
      const milestone = msIdx !== -1 ? process.argv[msIdx + 1] : null;
      const stIdx = process.argv.indexOf('--status');
      const status = stIdx !== -1 ? process.argv[stIdx + 1] : null;
      const tasks = tm.listTasks({ milestone, status });
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
  }
}

module.exports = TaskManager;
