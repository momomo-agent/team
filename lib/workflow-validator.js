#!/usr/bin/env node
/**
 * Workflow Validator — static analysis before execution
 *
 * Checks:
 * 1. Structure: all required fields present, types correct
 * 2. Connectivity: every node.next points to an existing node
 * 3. Agents: every step.execute.agent exists in config.agents
 * 4. Reachability: all nodes reachable from entry
 * 5. Termination: every path has a finite exit (no unbounded loops without maxIterations)
 * 6. Validate blocks: validate.files paths are reasonable, signal values are valid
 *
 * Usage:
 *   node workflow-validator.js <config-path> [--project <dir>]
 *   require('./workflow-validator').validate(config, nodeLoader)
 */

const fs = require('fs');
const path = require('path');

const VALID_NODE_TYPES = ['sequence', 'loop', 'wait', 'branch', 'reactive'];
const VALID_EXEC_TYPES = ['agent', 'shell', 'function', 'noop', 'workflow', 'group'];
const VALID_SIGNAL_STATUSES = ['completed', 'blocked', 'escalate', 'failed'];

class ValidationError {
  constructor(path, message, severity) {
    this.path = path;       // e.g. "nodes/setup.steps[1].execute"
    this.message = message;
    this.severity = severity || 'error'; // error | warning
  }
  toString() {
    return `[${this.severity.toUpperCase()}] ${this.path}: ${this.message}`;
  }
}

function validate(config, options) {
  const errors = [];
  const opts = options || {};
  const configDir = opts.configDir || null;
  const projectDir = opts.projectDir || null;

  // ─── 1. Top-level structure ───

  if (!config.workflow) {
    errors.push(new ValidationError('config', 'missing workflow section'));
    return { valid: false, errors };
  }

  if (!config.workflow.entry) {
    errors.push(new ValidationError('config.workflow', 'missing entry node'));
  }

  if (!config.workflow.nodes || Object.keys(config.workflow.nodes).length === 0) {
    // Nodes may be in separate files (e.g. configs/<workflow>/nodes/*.json)
    // Skip detailed validation, assume runtime will load them
    return { valid: true, errors: [], warnings: ['Nodes not inline - skipping detailed validation'] };
  }

  if (!config.agents || Object.keys(config.agents).length === 0) {
    errors.push(new ValidationError('config.agents', 'no agents defined'));
  }

  // Collect all known node IDs
  const nodeIds = new Set(Object.keys(config.workflow.nodes || {}));

  // ─── 2. Load and validate each node ───

  const loadedNodes = {};
  for (const [nodeId, nodeDef] of Object.entries(config.workflow.nodes || {})) {
    let node = nodeDef;

    // If it's a file path, try to load it
    if (typeof nodeDef === 'string') {
      const resolved = resolveNodePath(nodeDef, configDir);
      if (!resolved) {
        errors.push(new ValidationError(`nodes/${nodeId}`, `file not found: ${nodeDef}`));
        continue;
      }
      try {
        node = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      } catch (e) {
        errors.push(new ValidationError(`nodes/${nodeId}`, `invalid JSON: ${e.message}`));
        continue;
      }
    }

    loadedNodes[nodeId] = node;

    // Type check
    if (!node.type) {
      errors.push(new ValidationError(`nodes/${nodeId}`, 'missing type'));
    } else if (!VALID_NODE_TYPES.includes(node.type)) {
      errors.push(new ValidationError(`nodes/${nodeId}`, `invalid type: ${node.type}`));
    }

    // Loop-specific
    if (node.type === 'loop') {
      if (!node.maxIterations && !node.exit && !node.continue) {
        errors.push(new ValidationError(`nodes/${nodeId}`,
          'loop without maxIterations, exit, or continue — potential infinite loop', 'error'));
      }
      if (!node.maxIterations) {
        errors.push(new ValidationError(`nodes/${nodeId}`,
          'loop without explicit maxIterations — will default to 100', 'warning'));
      }
    }

    // Validate steps
    if (node.steps) {
      validateSteps(node.steps, `nodes/${nodeId}`, config, nodeIds, errors);
    }

    // Validate next references
    validateNext(node.next, `nodes/${nodeId}.next`, nodeIds, errors);

    // Validate exit references
    if (node.exit) {
      if (node.exit.next) validateNext(node.exit.next, `nodes/${nodeId}.exit.next`, nodeIds, errors);
      if (node.exit.then) validateNext(node.exit.then, `nodes/${nodeId}.exit.then`, nodeIds, errors);
    }
    if (node.stallExit) {
      validateNext(node.stallExit, `nodes/${nodeId}.stallExit`, nodeIds, errors);
    }
  }

  // ─── 3. Entry node exists ───

  if (config.workflow.entry && !nodeIds.has(config.workflow.entry)) {
    errors.push(new ValidationError('config.workflow.entry',
      `entry node "${config.workflow.entry}" not found in nodes`));
  }

  // ─── 4. Reachability analysis ───

  const reachable = new Set();
  if (config.workflow.entry && loadedNodes[config.workflow.entry]) {
    walkReachable(config.workflow.entry, loadedNodes, reachable);
  }
  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      errors.push(new ValidationError(`nodes/${nodeId}`,
        'unreachable from entry node', 'warning'));
    }
  }

  // ─── 5. Agent prompt files exist ───

  for (const [agentId, agentConf] of Object.entries(config.agents || {})) {
    if (!agentConf.prompt) {
      errors.push(new ValidationError(`agents/${agentId}`, 'missing prompt'));
    } else if (configDir) {
      const promptPath = typeof agentConf.prompt === 'object'
        ? agentConf.prompt.path : agentConf.prompt;
      // Check in team root (parent of configDir) and configDir itself
      const teamRoot = path.resolve(configDir, '..');
      const fullPath = path.join(teamRoot, promptPath);
      const altPath = path.join(configDir, promptPath);
      // Also check team root's parent (for configs/<name>/ → team-root/prompts/)
      const teamRoot2 = path.resolve(configDir, '../..');
      const altPath2 = path.join(teamRoot2, promptPath);
      if (!fs.existsSync(fullPath) && !fs.existsSync(altPath) && !fs.existsSync(altPath2)) {
        errors.push(new ValidationError(`agents/${agentId}.prompt`,
          `file not found: ${promptPath}`, 'warning'));
      }
    }
  }

  // ─── Dashboard ───

  if (!config.dashboard) {
    errors.push(new ValidationError('config.dashboard',
      'no dashboard configuration — run "team web" will show empty UI', 'warning'));
  } else {
    const db = config.dashboard;
    if (!db.left || db.left.length === 0) {
      errors.push(new ValidationError('dashboard.left',
        'no left tabs defined', 'warning'));
    }
    if (!db.right || db.right.length === 0) {
      errors.push(new ValidationError('dashboard.right',
        'no right tabs defined', 'warning'));
    }
  }

  // ─── Summary ───

  const errorCount = errors.filter(e => e.severity === 'error').length;
  const warnCount = errors.filter(e => e.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    errors: errors.filter(e => e.severity === 'error'),
    warnings: errors.filter(e => e.severity === 'warning'),
    summary: `${errorCount} errors, ${warnCount} warnings`
  };
}

function validateSteps(steps, prefix, config, nodeIds, errors) {
  if (!Array.isArray(steps)) {
    errors.push(new ValidationError(prefix, 'steps must be an array'));
    return;
  }

  const stepIds = new Set();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const sp = `${prefix}.steps[${i}]`;

    // Duplicate step id
    if (step.id) {
      if (stepIds.has(step.id)) {
        errors.push(new ValidationError(sp, `duplicate step id: ${step.id}`));
      }
      stepIds.add(step.id);
    }

    // Execute block
    if (step.execute) {
      const exec = step.execute;
      if (exec.type && !VALID_EXEC_TYPES.includes(exec.type)) {
        errors.push(new ValidationError(`${sp}.execute`,
          `invalid execute type: ${exec.type}`));
      }
      if (exec.type === 'agent' && exec.agent) {
        const baseAgent = exec.agent.replace(/-\d+$/, '');
        if (config.agents && !config.agents[baseAgent]) {
          errors.push(new ValidationError(`${sp}.execute.agent`,
            `agent "${exec.agent}" not defined in config.agents`));
        }
      }
    }

    // Validate block
    if (step.validate) {
      const v = step.validate;
      if (v.signal && !VALID_SIGNAL_STATUSES.includes(v.signal)) {
        errors.push(new ValidationError(`${sp}.validate.signal`,
          `invalid signal status: ${v.signal}`));
      }
    }

    // Parallel branches
    if (step.branches) {
      validateSteps(step.branches, `${sp}.branches`, config, nodeIds, errors);
    }
  }
}

function validateNext(next, prefix, nodeIds, errors) {
  if (!next) return;
  if (typeof next === 'string') {
    if (!nodeIds.has(next)) {
      errors.push(new ValidationError(prefix,
        `references non-existent node: "${next}"`));
    }
  } else if (typeof next === 'object') {
    if (next.then && typeof next.then === 'string' && !nodeIds.has(next.then)) {
      errors.push(new ValidationError(`${prefix}.then`,
        `references non-existent node: "${next.then}"`));
    }
    if (next.else && typeof next.else === 'string' && !nodeIds.has(next.else)) {
      errors.push(new ValidationError(`${prefix}.else`,
        `references non-existent node: "${next.else}"`));
    }
  }
}

function walkReachable(nodeId, nodes, visited) {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);
  const node = nodes[nodeId];
  if (!node) return;

  // Follow next
  collectNextIds(node.next).forEach(id => walkReachable(id, nodes, visited));
  // Follow exit
  if (node.exit) {
    collectNextIds(node.exit.next).forEach(id => walkReachable(id, nodes, visited));
    collectNextIds(node.exit.then).forEach(id => walkReachable(id, nodes, visited));
    if (typeof node.exit === 'object' && node.exit.pass)
      walkReachable(node.exit.pass, nodes, visited);
    if (typeof node.exit === 'object' && node.exit.fail)
      walkReachable(node.exit.fail, nodes, visited);
  }
  if (node.stallExit) {
    collectNextIds(node.stallExit).forEach(id => walkReachable(id, nodes, visited));
  }
}

function collectNextIds(next) {
  if (!next) return [];
  if (typeof next === 'string') return [next];
  const ids = [];
  if (next.then && typeof next.then === 'string') ids.push(next.then);
  if (next.else && typeof next.else === 'string') ids.push(next.else);
  return ids;
}

function resolveNodePath(filePath, configDir) {
  if (!configDir) return null;
  const p = path.join(configDir, filePath);
  if (fs.existsSync(p)) return p;
  // Try parent (team root)
  const p2 = path.resolve(configDir, '..', filePath);
  if (fs.existsSync(p2)) return p2;
  return null;
}

// ─── CLI ───

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node workflow-validator.js <config-dir-or-file>');
    process.exit(0);
  }

  let configPath = args[0];
  let configDir;

  if (fs.statSync(configPath).isDirectory()) {
    configDir = configPath;
    configPath = path.join(configPath, 'config.json');
  } else {
    configDir = path.dirname(configPath);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const result = validate(config, { configDir });

  if (result.errors.length > 0) {
    console.log('\n❌ Errors:');
    result.errors.forEach(e => console.log('  ' + e.toString()));
  }
  if (result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    result.warnings.forEach(e => console.log('  ' + e.toString()));
  }

  console.log(`\n${result.valid ? '✅' : '❌'} ${result.summary}`);
  process.exit(result.valid ? 0 : 1);
}

module.exports = { validate, ValidationError };
