#!/usr/bin/env node
/**
 * DevTeam Agent Runner
 * Executes Claude Code for each agent type with strict permission enforcement.
 * Prompts loaded from prompts/*.md, permissions from config.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEVTEAM_ROOT = path.join(__dirname, '..');
const TASK_MANAGER = path.join(DEVTEAM_ROOT, 'lib/task-manager.js');
const DEFAULT_CONFIG_PATH = path.join(DEVTEAM_ROOT, 'configs/default.json');

// --- Config Loading ---

function loadConfig(projectDir) {
  // Try project config first, fallback to default
  const projectConfigPath = path.join(projectDir, '.team/config.json');
  let projectConfig = {};
  try { projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')); } catch {}

  const defaultConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

  // If project config has 'agents' key, use it; otherwise use default
  const agents = projectConfig.agents || defaultConfig.agents;
  const workflow = projectConfig.workflow || defaultConfig.workflow;

  return { agents, workflow, defaultConfig };
}

function getAgentConfig(config, agentType) {
  const baseType = agentType.replace(/-\d+$/, '');
  return config.agents[baseType] || null;
}

// --- Prompt Building ---

function buildDynamicContext(projectDir, config) {
  // Build dynamic context for PM agent (kanban state, gaps, milestones)
  const parts = [];

  // Current kanban state
  const kanbanPath = path.join(projectDir, '.team/kanban.json');
  try {
    const kanban = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    const summary = [];
    for (const col of ['todo', 'inProgress', 'blocked', 'review', 'testing', 'done']) {
      const count = (kanban[col] || []).length;
      if (count > 0) summary.push(col + '=' + count);
    }
    if (summary.length > 0) {
      parts.push('Current kanban: ' + summary.join(', '));
    }
  } catch {}

  // Current gaps
  const gapsDir = path.join(projectDir, '.team/gaps');
  try {
    for (const f of ['vision.json', 'prd.json', 'dbb.json', 'architecture.json']) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(gapsDir, f), 'utf8'));
        const matchVal = g.match != null ? g.match : (g.coverage != null ? g.coverage : null);
        if (matchVal != null) {
          parts.push(f.replace('.json', '') + ' match: ' + matchVal + '%');
        }
      } catch {}
    }
  } catch {}

  // Current groups (milestones by default)
  const groupLabel = (config.groups && config.groups.label) || 'milestones';
  const msPath = path.join(projectDir, '.team', groupLabel, groupLabel + '.json');
  try {
    const ms = JSON.parse(fs.readFileSync(msPath, 'utf8'));
    if (ms.milestones && ms.milestones.length > 0) {
      const active = ms.milestones.find(function(m) { return m.status === 'active'; });
      if (active) {
        parts.push('Active group: ' + active.id + ' (' + active.name + '), tasks: ' + (active.tasks || []).length);
      }
      parts.push('Total milestones: ' + ms.milestones.length);
    }
  } catch {}

  if (parts.length === 0) return '';
  return '\nCurrent State:\n' + parts.map(function(p) { return '- ' + p; }).join('\n') + '\n';
}

function buildGapsSummary(projectDir) {
  const gapsDir = path.join(projectDir, '.team/gaps');
  const parts = [];
  for (const f of ['vision.json', 'prd.json', 'dbb.json']) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(gapsDir, f), 'utf8'));
      const name = f.replace('.json', '');
      const match = g.match != null ? g.match : g.coverage;
      const gaps = (g.gaps || []).filter(function(gap) { return gap.status !== 'resolved'; });
      if (gaps.length > 0) {
        parts.push(name + ' (match: ' + match + '%):\n' + gaps.map(function(gap) { return '  - ' + gap.description; }).join('\n'));
      }
    } catch {}
  }
  if (parts.length === 0) return '';
  return '\n\n## Monitor Gaps (MUST address in architecture)\n' + parts.join('\n\n') + '\n';
}

function buildExistingTasks(projectDir) {
  const tasksDir = path.join(projectDir, '.team/tasks');
  const tasks = [];
  try {
    for (const tid of fs.readdirSync(tasksDir)) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(tasksDir, tid, 'task.json'), 'utf8'));
        tasks.push('- [' + t.status + '] ' + t.id + ': ' + t.title);
      } catch {}
    }
  } catch {}
  if (tasks.length === 0) return '';
  return '\n\n## Existing Tasks (DO NOT create duplicates)\n' + tasks.join('\n') + '\n';
}

function buildPrompt(agentType, projectDir, agentId) {
  const baseType = agentType.replace(/-\d+$/, '');
  const config = loadConfig(projectDir);
  const agentConf = getAgentConfig(config, agentType);

  if (!agentConf) {
    console.error('Unknown agent type: ' + agentType);
    process.exit(1);
  }

  // Load prompt from file
  // Support both string format and object format
  let promptRelPath = agentConf.prompt;
  if (typeof promptRelPath === 'object' && promptRelPath.path) {
    promptRelPath = promptRelPath.path;
  }
  const promptPath = path.join(DEVTEAM_ROOT, promptRelPath);
  if (!fs.existsSync(promptPath)) {
    console.error('Prompt file not found: ' + promptPath);
    process.exit(1);
  }

  let prompt = fs.readFileSync(promptPath, 'utf8');

  // Replace placeholders
  prompt = prompt.replace(/\{\{TASK_MANAGER\}\}/g, TASK_MANAGER);
  prompt = prompt.replace(/\{\{projectDir\}\}/g, projectDir);
  prompt = prompt.replace(/\{\{AGENT_ID\}\}/g, agentId || agentType);

  // Replace dynamic context for PM
  if (baseType === 'pm') {
    var dynamicCtx = buildDynamicContext(projectDir, config);
    prompt = prompt.replace(/\{\{DYNAMIC_CONTEXT\}\}/g, dynamicCtx);
  }

  // Inject gaps summary + existing tasks if prompt uses these placeholders
  if (prompt.includes('{{GAPS_SUMMARY}}') || prompt.includes('{{EXISTING_TASKS}}')) {
    var gapsSummary = buildGapsSummary(projectDir);
    var existingTasks = buildExistingTasks(projectDir);
    prompt = prompt.replace(/\{\{GAPS_SUMMARY\}\}/g, gapsSummary);
    prompt = prompt.replace(/\{\{EXISTING_TASKS\}\}/g, existingTasks);
  }

  // Append signal protocol to all agent prompts
  prompt += '\n\n## Signal Protocol\n\n' +
    'When you finish, output a signal block so the system knows your status:\n\n' +
    '```signal\n{"status": "completed", "summary": "what you did"}\n```\n\n' +
    'Status values:\n' +
    '- `completed` — task done successfully\n' +
    '- `blocked` — cannot proceed, need something external\n' +
    '- `escalate` — tried but no progress possible, need human or different approach\n\n' +
    'The signal block is **required**. Place it at the end of your output.\n';

  // Inject retry context if previous run failed validation
  var retryPath = path.join(projectDir, '.team/retry-context.md');
  if (fs.existsSync(retryPath)) {
    prompt += '\n' + fs.readFileSync(retryPath, 'utf8');
    // Clean up so next normal run doesn't see it
    try { fs.unlinkSync(retryPath); } catch {}
  }

  return prompt;
}

function runAgent(agentType, projectDir) {
  var agentId = agentType;
  var config = loadConfig(projectDir);
  var baseType = agentType.replace(/-\d+$/, '');
  var agentConf = getAgentConfig(config, agentType);
  var prompt = buildPrompt(agentType, projectDir, agentId);

  console.log('[' + new Date().toISOString() + '] Running ' + agentType + ' agent...');

  // Ensure required directories exist
  var groupLbl = (config.groups && config.groups.label) || 'milestones';
  var dirsToEnsure = [
    '.team', '.team/gaps', '.team/gaps/' + groupLbl,
    '.team/change-requests', '.team/' + groupLbl, '.team/tasks'
  ];
  for (var i = 0; i < dirsToEnsure.length; i++) {
    var full = path.join(projectDir, dirsToEnsure[i]);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  }

  var tmpPrompt = path.join(projectDir, '.team/.prompt-' + agentType + '-' + Date.now() + '.md');
  fs.writeFileSync(tmpPrompt, prompt);

  try {
    // Determine backend from config
    // Priority: agent.backend > config.defaults.backend > 'claude-code'
    var backend = (agentConf && agentConf.backend) ||
                  (config.defaults && config.defaults.backend) ||
                  'claude-code';
    var model = (agentConf && agentConf.model) || '';
    var timeout = 15 * 60 * 1000; // 15 minutes — if not done, it's stuck

    var cmd;
    switch (backend) {
      case 'claude-code':
        // Claude Code CLI — full agent with file access
        cmd = 'claude --print --dangerously-skip-permissions < "' + tmpPrompt + '"';
        break;

      case 'codex':
        // OpenAI Codex CLI
        cmd = 'codex exec --full-auto "$(cat \'' + tmpPrompt + '\')"';
        break;

      case 'llm':
        // Generic LLM CLI (~/LOCAL/momo-agent/tools/llm/llm.js)
        // For agents that only need text output, not file manipulation
        var modelFlag = model ? ' --model ' + model : '';
        cmd = 'cat "' + tmpPrompt + '" | llm' + modelFlag;
        break;

      case 'shell':
        // Direct shell command from config
        cmd = (agentConf && agentConf.command) || 'echo "no command configured"';
        break;

      default:
        // Treat backend as a command template
        // {prompt} replaced with prompt file path
        cmd = backend.replace(/\{prompt\}/g, tmpPrompt);
        break;
    }

    // Capture agent output for signal extraction
    var output = execSync(cmd, {
      cwd: projectDir,
      timeout: timeout,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: Object.assign({}, process.env, { CI: 'true' })
    });

    // Write output to daemon log (replaces stdio: 'inherit')
    if (output) process.stdout.write(output);

    // Extract and write agent signal
    writeAgentSignal(agentType, projectDir, output, 0);

    console.log('[' + new Date().toISOString() + '] ' + agentType + ' agent completed');
  } catch (err) {
    // Write failure signal
    var errOutput = (err.stdout || '') + (err.stderr || '');
    writeAgentSignal(agentType, projectDir, errOutput, err.status || 1);

    if (err.message && (err.message.includes('524') || err.message.includes('timeout'))) {
      console.error('[' + new Date().toISOString() + '] ' + agentType + ' agent timed out');
    } else {
      console.error('[' + new Date().toISOString() + '] ' + agentType + ' agent failed:', err.message);
    }
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch {}
  }
}

/**
 * Extract structured signal from agent output and write to .team/signals/<agent>.json
 *
 * Agents can emit signals by including a JSON block in their output:
 *   ```signal
 *   {"status": "done|blocked|escalate", "summary": "...", "artifacts": [...]}
 *   ```
 *
 * If no explicit signal block, infer from output patterns:
 * - Output contains TERMINATE/DONE/TASK_COMPLETED → done
 * - Output contains BLOCKED/STUCK/ESCALATE → blocked
 * - Exit code != 0 → failed
 * - Otherwise → completed (implicit)
 */
function writeAgentSignal(agentType, projectDir, output, exitCode) {
  var signalDir = path.join(projectDir, '.team/signals');
  if (!fs.existsSync(signalDir)) fs.mkdirSync(signalDir, { recursive: true });

  var signal = { agent: agentType, timestamp: new Date().toISOString(), exitCode: exitCode };

  // Try to extract explicit signal block
  var signalMatch = (output || '').match(/```signal\s*\n([\s\S]*?)\n```/);
  if (signalMatch) {
    try {
      var explicit = JSON.parse(signalMatch[1].trim());
      Object.assign(signal, explicit);
    } catch {}
  }

  // If no explicit status, infer from output
  if (!signal.status) {
    if (exitCode !== 0) {
      signal.status = 'failed';
    } else if (/\b(ESCALATE|STUCK|NO_PROGRESS)\b/.test(output || '')) {
      signal.status = 'escalate';
    } else if (/\b(BLOCKED)\b/.test(output || '')) {
      signal.status = 'blocked';
    } else {
      signal.status = 'completed';
    }
  }

  // Extract summary: last non-empty line or explicit summary
  if (!signal.summary) {
    var lines = (output || '').trim().split('\n').filter(function(l) {
      return l.trim() && !l.startsWith('[') && !l.startsWith('```');
    });
    signal.summary = (lines[lines.length - 1] || '').slice(0, 200);
  }

  fs.writeFileSync(path.join(signalDir, agentType + '.json'), JSON.stringify(signal, null, 2));
}

// --- CLI entry point ---
var agentType = process.argv[2];
var projectDir = process.argv[3] || process.cwd();

if (!agentType) {
  console.log('Usage: node runner.js <agent-type> [project-dir]');
  console.log('Agent types: architect, pm, tech_lead, developer[-N], tester[-N],');
  console.log('             vision_monitor, prd_monitor, dbb_monitor, arch_monitor');
  process.exit(1);
}

runAgent(agentType, projectDir);
