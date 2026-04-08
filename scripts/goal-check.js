#!/usr/bin/env node
/**
 * Goal Check — writes .team/goal-status.md for PM to read each loop
 * 
 * Includes: goal, match%, critical gaps, recent deliverables (git log + completed tasks)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dir = process.cwd();
const teamDir = path.join(dir, '.team');

// 1. Goal
let goal = '(no goal)';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(teamDir, 'config.json'), 'utf8'));
  goal = (cfg.goal && cfg.goal.description) || '(no goal)';
} catch {}

// 2. Match + Critical gaps
const gapsDir = path.join(teamDir, 'gaps');
let matchSummary = '';
let totalCritical = 0;
if (fs.existsSync(gapsDir)) {
  fs.readdirSync(gapsDir).filter(f => f.endsWith('.json')).forEach(f => {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(gapsDir, f), 'utf8'));
      const name = f.replace('.json', '');
      const match = g.match || '?';
      const gaps = g.gaps || [];
      const criticals = gaps.filter(g => g.severity === 'critical' && g.status !== 'implemented');
      totalCritical += criticals.length;
      matchSummary += `- ${name}: ${match}%`;
      if (criticals.length > 0) {
        matchSummary += ` ⚠️ ${criticals.length} CRITICAL`;
        criticals.forEach(c => { matchSummary += `\n  - 🔴 ${c.description}`; });
      }
      matchSummary += '\n';
    } catch {}
  });
}

// 3. Recent deliverables — last 10 commits
let recentCommits = '';
try {
  recentCommits = execSync('git log --oneline -10 --no-merges 2>/dev/null', {
    cwd: dir, encoding: 'utf8', timeout: 5000
  }).trim();
} catch {}

// 4. Recently completed tasks (last 5)
let recentTasks = '';
const tasksDir = path.join(teamDir, 'tasks');
if (fs.existsSync(tasksDir)) {
  const completed = [];
  fs.readdirSync(tasksDir).forEach(f => {
    try {
      const taskPath = path.join(tasksDir, f);
      const jsonPath = fs.statSync(taskPath).isDirectory()
        ? path.join(taskPath, 'task.json') : taskPath;
      const t = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (t.status === 'done' && t.completedAt) {
        completed.push({ title: t.title || t.description || f, completedAt: t.completedAt });
      }
    } catch {}
  });
  completed.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  recentTasks = completed.slice(0, 5).map(t => `- ✅ ${t.title}`).join('\n');
}

// 5. Write goal-status.md
const out = `# Goal Status

## 🎯 Goal
${goal}

## 📊 Current Match
${matchSummary || '(no gap data yet)'}
${totalCritical > 0 ? `\n**${totalCritical} CRITICAL GAPS REMAIN — focus here first!**\n` : ''}
## 📦 Recent Deliverables
### Commits
${recentCommits || '(none)'}

### Completed Tasks
${recentTasks || '(none)'}

---
*Ask yourself: "What's the shortest path from here to the goal?"*
*Don't create tasks for completeness — only tasks that close the gap.*
`;

fs.writeFileSync(path.join(teamDir, 'goal-status.md'), out);
console.log(out);
