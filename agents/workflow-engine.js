/**
 * Workflow Engine v4 — Step-First Architecture
 * 
 * Step 是主语，不是 agent。
 * engine 不知道任何 agent name 或 task status name。
 * 
 * Step 定义:
 *   when     — 前置条件表达式
 *   execute  — { type: "agent"|"shell"|"noop", agent?, command?, parallel? }
 *   demand   — 并行实例数表达式
 *   post     — 状态保证声明 { tasks_in, must_become, evidence, on_fail_signal, ... }
 */

const fs = require('fs');
const path = require('path');

const RuntimeInterface = require('../lib/runtime-interface');

class WorkflowEngine {
  constructor(config, runtime) {
    // Validate runtime implements the interface
    const required = ['runAgent', 'getGroups', 'getKanban', 'isGroupComplete',
      'executeFunction', 'log', 'on', 'off',
      'readTask', 'updateTaskFields', 'listTaskDirs', 'readTaskFile',
      'listCRFiles', 'readCRFile', 'updateCRFile', 'readGap', 'fileExists'];
    for (const method of required) {
      if (typeof runtime[method] !== 'function') {
        throw new Error(`Runtime missing required method: ${method}`);
      }
    }
    if (!runtime.projectDir) {
      throw new Error('Runtime missing required property: projectDir');
    }

    this.config = config;
    this.runtime = runtime;
    this.currentNode = null;
    this.visitedNodes = [];
    this.loopIterations = new Map();
    this.transitionDepth = 0;
    this.maxTransitions = (config.workflow && config.workflow.maxTransitions) || 200;

    // Checkpoint support
    this._checkpointDir = runtime.projectDir
      ? path.join(runtime.projectDir, '.team', 'checkpoints')
      : null;
    this._workflowId = config._workflow || 'default';
    this._maxConcurrency = (config.workflow && config.workflow.maxConcurrency) || 3;
  }

  // ─── Checkpoint: Save & Restore ───

  _checkpointPath() {
    if (!this._checkpointDir) return null;
    return path.join(this._checkpointDir, this._workflowId + '.json');
  }

  saveCheckpoint(nodeId, stepIndex, extra) {
    const cpPath = this._checkpointPath();
    if (!cpPath) return;
    fs.mkdirSync(this._checkpointDir, { recursive: true });
    const cp = {
      workflowId: this._workflowId,
      nodeId,
      stepIndex: stepIndex != null ? stepIndex : -1,
      visitedNodes: [...this.visitedNodes],
      loopIterations: Object.fromEntries(this.loopIterations),
      transitionDepth: this.transitionDepth,
      nodeVisitCounts: this._nodeVisitCounts || {},
      contextOverrides: this.runtime._contextOverrides || {},
      timestamp: new Date().toISOString(),
      ...extra
    };
    fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));
  }

  loadCheckpoint() {
    const cpPath = this._checkpointPath();
    if (!cpPath || !fs.existsSync(cpPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    } catch { return null; }
  }

  clearCheckpoint() {
    const cpPath = this._checkpointPath();
    if (cpPath && fs.existsSync(cpPath)) {
      fs.unlinkSync(cpPath);
    }
  }

  // ─── Workflow Entry ───

  async execute() {
    // Check for checkpoint to resume from
    const cp = this.loadCheckpoint();
    if (cp) {
      this.runtime.log('workflow', null,
        `[RESUME] Resuming from checkpoint: node=${cp.nodeId}, step=${cp.stepIndex}`);
      // Restore state
      this.visitedNodes = cp.visitedNodes || [];
      this.loopIterations = new Map(Object.entries(cp.loopIterations || {}));
      this.transitionDepth = cp.transitionDepth || 0;
      this._nodeVisitCounts = cp.nodeVisitCounts || {};
      if (cp.contextOverrides && this.runtime._contextOverrides) {
        Object.assign(this.runtime._contextOverrides, cp.contextOverrides);
      }
      // Resume from checkpointed node
      await this.executeNode(cp.nodeId, cp.stepIndex);
      // Workflow complete after resume — clear checkpoint
      this.clearCheckpoint();
      return;
    }

    const entry = this.config.workflow.entry || 'startup';
    await this.executeNode(entry);

    // Workflow complete — clear checkpoint
    this.clearCheckpoint();
  }

  // ─── Node Execution ───

  async executeNode(nodeId, resumeStepIndex) {
    if (!nodeId) return;

    this.transitionDepth++;
    if (this.transitionDepth > this.maxTransitions) {
      this.runtime.log('error', 'workflow',
        `[ABORT] Max transitions (${this.maxTransitions}). Last: ${nodeId}`);
      return;
    }

    // ─── Ping-pong / spin detection ───
    // Count how many times each node has been visited.
    // If a non-loop node is visited > maxNodeRevisits times, force stop.
    if (!this._nodeVisitCounts) this._nodeVisitCounts = {};
    this._nodeVisitCounts[nodeId] = (this._nodeVisitCounts[nodeId] || 0) + 1;

    const node = this.loadNode(nodeId);
    if (!node) {
      this.runtime.log('error', 'workflow', `Node not found: ${nodeId}`);
      return;
    }

    const maxRevisits = node.maxRevisits || (this.config.workflow && this.config.workflow.maxNodeRevisits) || 5;
    if (node.type !== 'loop' && this._nodeVisitCounts[nodeId] > maxRevisits) {
      this.runtime.log('error', 'workflow',
        `[SPIN-EXIT] Node "${nodeId}" visited ${this._nodeVisitCounts[nodeId]} times (max ${maxRevisits}) — breaking cycle`);
      return;
    }

    this.currentNode = nodeId;
    this.visitedNodes.push(nodeId);
    this.runtime.log('agent_start', nodeId, `[NODE] ${nodeId} - ${node.description || ''}`);

    const ctx = this.buildContext();

    switch (node.type) {
      case 'sequence':
        await this.runSteps(node.steps, ctx, resumeStepIndex);
        await this.followNext(node.next, ctx);
        break;
      case 'loop':
        await this.executeLoop(node, ctx);
        break;
      case 'wait':
        await this.executeWait(node, ctx);
        break;
      case 'branch':
        await this.followNext(node.next, this.buildContext());
        break;
      case 'reactive':
        await this.executeReactive(node, ctx);
        break;
    }
  }

  // ─── Step Execution (core) ───

  async runSteps(steps, ctx, resumeFromStep) {
    if (!steps) return;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Skip already-executed steps when resuming
      if (resumeFromStep != null && resumeFromStep >= 0 && i < resumeFromStep) {
        this.runtime.log('workflow', this.currentNode,
          `[SKIP-RESUME] step ${i} (${step.id || '?'}) already done`);
        continue;
      }

      // Save checkpoint before each step
      this.saveCheckpoint(this.currentNode, i);

      // 前置条件
      const when = step.when || step.trigger || step.condition;
      if (when && !this.evaluate(when, ctx)) {
        this.runtime.log('workflow', this.currentNode,
          `[SKIP] ${step.id || step.execute?.agent || '?'}: ${when}`);
        continue;
      }

      // 执行
      if (step.parallel && step.branches) {
        // Parallel branches: run all eligible branches concurrently
        const eligible = step.branches.filter(b => {
          const w = b.when || b.trigger || b.condition;
          if (w && !this.evaluate(w, ctx)) {
            this.runtime.log('workflow', this.currentNode,
              `[PARALLEL-SKIP] ${b.id || '?'}: ${w}`);
            return false;
          }
          return true;
        });

        if (eligible.length > 0) {
          this.runtime.log('workflow', this.currentNode,
            `[PARALLEL] ${eligible.map(b => b.id || '?').join(', ')}`);
          await this._runWithConcurrency(eligible.map(branch => async () => {
            await this.executeStep(branch, ctx);
            if (branch.post) this.enforcePost(branch.post);
          }));
        }
      } else {
        await this.executeStep(step, ctx);
      }

      // CR 分支：agent 执行后可能提交了 CR
      if (step.cr && step.cr.enabled && step.execute && step.execute.type === 'agent') {
        const crResult = await this.handleStepCR(step, ctx);
        if (crResult === 'retry') {
          // Upstream accepted CR and fixed — re-run this step
          this.runtime.log('workflow', this.currentNode,
            `[CR-RETRY] Re-running step ${step.id || i} after upstream fix`);
          i--; // decrement to re-run same step
          Object.assign(ctx, this.buildContext());
          continue;
        }
      }

      // 后置保证
      if (step.post) {
        this.enforcePost(step.post);
      }

      // ─── Output Validation ───
      // Unified validation: files exist, content matches, signal status
      const validate = step.validate || step.ensure || null;
      if (validate) {
        const failures = this._validateStepOutput(validate, step);
        if (failures.length > 0) {
          this.runtime.log('workflow', this.currentNode,
            `[VALIDATE-FAIL] ${step.id || '?'}: ${failures.join('; ')}`);
          // Retry logic: re-run step up to maxRetries
          const retryKey = this.currentNode + '/' + (step.id || i);
          if (!this._validateRetries) this._validateRetries = {};
          this._validateRetries[retryKey] = (this._validateRetries[retryKey] || 0) + 1;
          const maxRetries = (validate.maxRetries != null ? validate.maxRetries : 1);
          if (this._validateRetries[retryKey] <= maxRetries) {
            this.runtime.log('workflow', this.currentNode,
              `[VALIDATE-RETRY] ${step.id || '?'} (${this._validateRetries[retryKey]}/${maxRetries})`);
            // Run a focused fix agent instead of full retry
            const failureMsg = failures.join('; ');
            await this._runFixAgent(step, failureMsg, this._validateRetries[retryKey]);
            // Re-validate after fix attempt
            const recheck = this._validateStepOutput(validate, step);
            if (recheck.length === 0) {
              this.runtime.log('workflow', this.currentNode,
                `[VALIDATE-FIXED] ${step.id || '?'} passed after fix`);
            } else {
              this.runtime.log('workflow', this.currentNode,
                `[VALIDATE-STILL-FAIL] ${step.id || '?'}: ${recheck.join('; ')}`);
            }
            // Don't i-- anymore — fix agent already ran, continue to next step
            // If still failing after all retries, it falls through naturally
            continue;
          }
        }
      }

      // step 可能改变了世界状态，刷新 context
      Object.assign(ctx, this.buildContext());
    }
  }

  // ─── CR Branch: check for CRs after step execution ───
  //
  // When a step has cr.enabled, the agent can submit CRs via daemon.submitCR().
  // After agent execution, engine checks for pending CRs from this agent.
  // If found: route to upstream → upstream runs → re-run this step.
  // Max retries controlled by cr.maxRetries (default 2).

  async handleStepCR(step, ctx) {
    if (!step.cr || !step.cr.enabled) return null;

    const agent = step.execute.agent;
    const maxRetries = step.cr.maxRetries || 2;

    if (!this._crRetries) this._crRetries = {};
    const retryKey = this.currentNode + '/' + (step.id || agent);
    this._crRetries[retryKey] = (this._crRetries[retryKey] || 0);

    if (this._crRetries[retryKey] >= maxRetries) {
      this.runtime.log('workflow', this.currentNode,
        `[CR] Max retries (${maxRetries}) reached for ${retryKey}, continuing`);
      return null;
    }

    const files = this.runtime.listCRFiles();
    if (!files.length) return null;

    for (const f of files) {
      try {
        const cr = this.runtime.readCRFile(f);
        if (!cr || cr.status !== 'pending' || cr.from !== agent) continue;

        this.runtime.log('workflow', this.currentNode,
          `[CR] ${cr.id}: ${cr.from} → ${cr.to} | ${cr.impact}`);
        this.runtime.log('workflow', this.currentNode,
          `[CR-FIX] Running ${cr.to} to address: ${cr.proposal}`);
        await this.runtime.runAgent(cr.to);

        this.runtime.updateCRFile(f, {
          status: 'accepted',
          reviewedAt: new Date().toISOString()
        });

        this._crRetries[retryKey]++;
        return 'retry';
      } catch {}
    }
    return null;
  }

  async executeStep(step, ctx) {
    const exec = step.execute;

    // 兼容 v3: step.agents 直接写 agent 列表
    if (!exec && step.agents) {
      return this.executeStepAgentsCompat(step, ctx);
    }

    if (!exec || exec.type === 'noop') return;

    switch (exec.type) {
      case 'agent':
        await this.executeStepAgent(exec, step, ctx);
        break;
      case 'shell':
        await this.executeStepShell(exec, step, ctx);
        break;
      case 'function':
        if (typeof exec.fn === 'function') {
          await exec.fn(ctx);
        } else if (typeof exec.fn === 'string' && this.runtime.executeFunction) {
          await this.runtime.executeFunction(exec.fn, ctx);
        }
        break;
      case 'team':
      case 'workflow': // backward compat
        await this.executeStepTeam(exec, step, ctx);
        break;
      case 'group':
        await this.executeStepGroup(exec, step, ctx);
        break;
    }
  }

  async executeStepAgent(exec, step, ctx) {
    const agent = exec.agent;
    const parallel = exec.parallel || 1;

    let signal = null;

    if (parallel <= 1) {
      // 串行：demand 决定跑几次
      const demand = step.demand ? this.evaluateExpr(step.demand, ctx) : 1;
      const count = Math.max(1, Math.min(demand, 1)); // 串行最多 1
      this.runtime.log('workflow', this.currentNode, `[EXEC] ${agent}`);
      signal = await this.runtime.runAgent(agent);
    } else {
      // 并行
      const demand = step.demand ? this.evaluateExpr(step.demand, ctx) : 1;
      const count = Math.min(demand, parallel);
      if (count <= 0) {
        this.runtime.log('workflow', this.currentNode, `[SKIP] ${agent}: demand=0`);
        return;
      }
      if (count === 1) {
        this.runtime.log('workflow', this.currentNode, `[EXEC] ${agent}`);
        signal = await this.runtime.runAgent(agent);
      } else {
        const instances = [];
        for (let i = 1; i <= count; i++) instances.push(`${agent}-${i}`);
        this.runtime.log('workflow', this.currentNode, `[PARALLEL] ${instances.join(', ')}`);
        await this._runWithConcurrency(instances.map(a => () => this.runtime.runAgent(a)));
      }
    }

    // Process agent signal for flow control
    if (signal && typeof signal === 'object' && signal.status) {
      if (signal.status === 'escalate' || signal.status === 'blocked') {
        this.runtime.log('workflow', this.currentNode,
          `[AGENT-SIGNAL] ${agent} → ${signal.status}: ${(signal.summary || '').slice(0, 80)}`);
        // Store signal in context for exit conditions to use
        if (!this.runtime._contextOverrides) this.runtime._contextOverrides = {};
        this.runtime._contextOverrides['lastAgentSignal'] = signal.status;
        this.runtime._contextOverrides['agentEscalated'] = signal.status === 'escalate' ? 1 : 0;
        this.runtime._contextOverrides['agentBlocked'] = signal.status === 'blocked' ? 1 : 0;
      }
    }
  }

  async executeStepShell(exec, step, ctx) {
    const { execSync } = require('child_process');
    const cwd = exec.cwd
      ? exec.cwd.replace('{{projectDir}}', this.runtime.projectDir)
      : this.runtime.projectDir;
    const cmd = exec.command;
    this.runtime.log('workflow', this.currentNode, `[SHELL] ${cmd}`);
    try {
      const output = execSync(cmd, { cwd, stdio: 'pipe', timeout: exec.timeout || 60000 });
      if (step.post && step.post.on_exit_0) {
        this.applyContextOverrides(step.post.on_exit_0);
      }
    } catch (e) {
      this.runtime.log('error', this.currentNode, `[SHELL] exit ${e.status}: ${e.message}`);
      if (step.post && step.post.on_exit_nonzero) {
        this.applyContextOverrides(step.post.on_exit_nonzero);
      }
    }
  }

  async executeStepTeam(exec, step, ctx) {
    const configName = exec.config;
    const maxDepth = exec.maxDepth || 5;

    // Depth guard
    const currentDepth = (this._subWorkflowDepth || 0) + 1;
    if (currentDepth > maxDepth) {
      this.runtime.log('error', this.currentNode,
        `[TEAM] Max nesting depth (${maxDepth}) exceeded for "${configName}"`);
      return;
    }

    // Load sub-workflow config
    const configPath = path.join(__dirname, '../configs', configName, 'config.json');
    if (!fs.existsSync(configPath)) {
      this.runtime.log('error', this.currentNode,
        `[TEAM] Config not found: configs/${configName}/config.json`);
      return;
    }

    const subConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    subConfig._workflow = configName;

    // Merge parent context overrides into sub-workflow
    if (exec.context) {
      if (!subConfig.workflow.context) subConfig.workflow.context = {};
      Object.assign(subConfig.workflow.context, exec.context);
    }

    this.runtime.log('workflow', this.currentNode,
      `[TEAM] → ${configName} (depth ${currentDepth})`);

    // Create and run sub-engine
    const subEngine = new WorkflowEngine(subConfig, this.runtime);
    subEngine._subWorkflowDepth = currentDepth;
    await subEngine.execute();

    this.runtime.log('workflow', this.currentNode,
      `[TEAM] ← ${configName} done`);
  }

  async executeStepGroup(exec, step, ctx) {
    const groupLabel = (this.config.groups && this.config.groups.label) || 'milestones';
    const groupId = exec.group; // "active", "all", or specific id
    const configName = exec.config; // sub-workflow to run for this group

    // Resolve groups
    const data = this.runtime.getGroups();
    const allGroups = data.groups || data.milestones || [];
    let groups = [];

    if (groupId === 'all') {
      // All non-done groups
      groups = allGroups.filter(g => g.status !== 'done' && g.status !== 'completed');
    } else if (groupId === 'active' || !groupId) {
      const active = allGroups.find(g =>
        g.status === 'active' || g.status === 'ready-for-work' || g.status === 'in-progress');
      if (active) groups = [active];
    } else {
      const found = allGroups.find(g => g.id === groupId);
      if (found) groups = [found];
    }

    if (groups.length === 0) {
      this.runtime.log('workflow', this.currentNode,
        `[GROUP] No ${groupLabel} found for "${groupId}", skipping`);
      return;
    }

    if (!configName) {
      for (const g of groups) {
        this.runtime.log('workflow', this.currentNode,
          `[GROUP] ${groupLabel}/${g.id} (${g.name}) selected (no sub-workflow)`);
      }
      return;
    }

    // Parallel or serial execution
    if (exec.parallel && groups.length > 1) {
      this.runtime.log('workflow', this.currentNode,
        `[GROUP] ${groups.length} ${groupLabel} in parallel: ${groups.map(g => g.id).join(', ')}`);

      await Promise.all(groups.map(group => {
        const subExec = {
          type: 'workflow',
          config: configName,
          maxDepth: exec.maxDepth || 5,
          context: Object.assign({}, exec.context || {}, {
            currentGroup: group.id,
            currentGroupName: group.name,
            currentGroupTasks: (group.tasks || []).length
          })
        };
        return this.executeStepTeam(subExec, step, ctx);
      }));
    } else {
      // Serial: one group at a time
      for (const group of groups) {
        this.runtime.log('workflow', this.currentNode,
          `[GROUP] ${groupLabel}/${group.id} (${group.name}) — ${(group.tasks || []).length} tasks`);

        const subExec = {
          type: 'workflow',
          config: configName,
          maxDepth: exec.maxDepth || 5,
          context: Object.assign({}, exec.context || {}, {
            currentGroup: group.id,
            currentGroupName: group.name,
            currentGroupTasks: (group.tasks || []).length
          })
        };
        await this.executeStepTeam(subExec, step, ctx);
      }
    }
  }

  // v3 兼容: step.agents 写法
  async executeStepAgentsCompat(step, ctx) {
    const agents = step.agents;
    if (step.scalable || (step.execute && step.execute.parallel > 1)) {
      // 转成 v4 格式执行
      const exec = { type: 'agent', agent: agents[0], parallel: step.maxParallel || 1 };
      await this.executeStepAgent(exec, step, ctx);
    } else if (step.parallel) {
      this.runtime.log('workflow', this.currentNode, `[PARALLEL] ${agents.join(', ')}`);
      await Promise.all(agents.map(a => this.runtime.runAgent(a)));
    } else {
      for (const agent of agents) {
        this.runtime.log('workflow', this.currentNode, `[EXEC] ${agent}`);
        await this.runtime.runAgent(agent);
      }
    }
  }

  applyContextOverrides(overrides) {
    if (overrides && overrides.set_context) {
      // 写入 daemon 的共享状态（简单 key-value）
      if (!this.runtime._contextOverrides) this.runtime._contextOverrides = {};
      Object.assign(this.runtime._contextOverrides, overrides.set_context);
    }
  }

  // ─── Output Validation ───

  /**
   * Validate step output against declared expectations.
   * Returns array of failure descriptions (empty = all passed).
   *
   * Config format:
   *   validate: {
   *     files: [".team/baseline.json"],       // must exist after step
   *     filesNotEmpty: ["experiments.log"],    // must exist and not be empty
   *     signal: "completed",                  // agent signal must match
   *     maxRetries: 1                         // how many times to retry on failure
   *   }
   */
  /**
   * Run a focused fix agent to address specific validation failures.
   * Instead of re-running the entire step, this agent only fixes what's missing.
   */
  async _runFixAgent(step, failureMsg, attempt) {
    const agent = step.execute && step.execute.agent;
    if (!agent) return;

    // Write a targeted fix prompt
    const fixPrompt =
      `# Fix Required (attempt ${attempt})\n\n` +
      `The previous "${agent}" agent completed but its output failed validation:\n\n` +
      `**Failures:**\n${failureMsg.split('; ').map(f => '- ' + f).join('\n')}\n\n` +
      `## Your Task\n\n` +
      `Fix ONLY the issues listed above. Do not redo work that was already done correctly.\n\n` +
      `## Working Directory\n${this.runtime.projectDir}\n\n` +
      '## Signal Protocol\n\n' +
      'When done, output:\n```signal\n{"status": "completed", "summary": "what you fixed"}\n```\n';

    const fixPromptPath = path.join(this.runtime.projectDir, '.team', '.prompt-fix-' + Date.now() + '.md');
    fs.writeFileSync(fixPromptPath, fixPrompt);

    try {
      // Use same backend as the original agent
      const baseType = agent.replace(/-\d+$/, '');
      const agentConf = (this.config.agents && this.config.agents[baseType]) || {};
      const backend = agentConf.backend || 'claude-code';
      const model = agentConf.model || '';

      let cmd;
      if (backend === 'claude-code') {
        cmd = `claude --print --dangerously-skip-permissions < "${fixPromptPath}"`;
      } else if (backend === 'llm') {
        const modelFlag = model ? ' --model ' + model : '';
        cmd = `cat "${fixPromptPath}" | llm${modelFlag}`;
      } else {
        cmd = `claude --print --dangerously-skip-permissions < "${fixPromptPath}"`;
      }

      this.runtime.log('workflow', this.currentNode, `[FIX] Running fix agent for ${agent}`);
      const { execSync } = require('child_process');
      execSync(cmd, {
        cwd: this.runtime.projectDir,
        timeout: 5 * 60 * 1000, // 5min max for fixes
        stdio: 'inherit'
      });
    } catch (err) {
      this.runtime.log('workflow', this.currentNode,
        `[FIX-FAIL] Fix agent failed: ${err.message}`);
    } finally {
      try { fs.unlinkSync(fixPromptPath); } catch {}
    }
  }

  /**
   * Write retry context so the re-run agent knows what went wrong.
   * runner.js reads .team/retry-context.md and appends to prompt.
   */
  _writeRetryContext(step, failureMsg, attempt) {
    const agent = step.execute && step.execute.agent;
    if (!agent) return;
    const retryPath = path.join(this.runtime.projectDir, '.team', 'retry-context.md');
    const content = `## Retry (attempt ${attempt})\n\n` +
      `Your previous run failed output validation:\n` +
      `- ${failureMsg}\n\n` +
      `Please fix these issues this time. The system will verify again after you finish.\n`;
    fs.writeFileSync(retryPath, content);
  }

  _validateStepOutput(validate, step) {
    const failures = [];

    // File existence
    if (validate.files) {
      for (const f of validate.files) {
        const fullPath = path.join(this.runtime.projectDir, f);
        if (!fs.existsSync(fullPath)) {
          failures.push(`file missing: ${f}`);
          // Auto-recover baseline.json
          if (f === '.team/baseline.json') {
            this._tryCreateBaselineFromLog(fullPath);
            if (fs.existsSync(fullPath)) {
              failures.pop(); // Recovered, remove failure
            }
          }
        }
      }
    }

    // File not empty
    if (validate.filesNotEmpty) {
      for (const f of validate.filesNotEmpty) {
        const fullPath = path.join(this.runtime.projectDir, f);
        try {
          const content = fs.readFileSync(fullPath, 'utf8').trim();
          if (!content) failures.push(`file empty: ${f}`);
        } catch {
          failures.push(`file missing: ${f}`);
        }
      }
    }

    // Agent signal status
    if (validate.signal && step.execute && step.execute.agent) {
      const signal = this.runtime.readAgentSignal(step.execute.agent);
      if (!signal) {
        failures.push(`no signal from ${step.execute.agent}`);
      } else if (signal.status !== validate.signal) {
        failures.push(`signal ${signal.status} != expected ${validate.signal}`);
      }
    }

    return failures;
  }

  // ─── Postcondition Enforcement ───

  _tryCreateBaselineFromLog(baselinePath) {
    // Fallback: if evaluator forgot to create baseline.json, extract from experiments.log
    const logPath = path.join(this.runtime.projectDir, 'experiments.log');
    if (!fs.existsSync(logPath)) return;
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      // Find first line with numeric metrics (seedRecall, etc.)
      for (const line of lines) {
        const entry = JSON.parse(line);
        // Check if it has metrics.after or direct numeric fields
        const metrics = entry.metrics?.after || {};
        const directMetrics = {};
        for (const [k, v] of Object.entries(entry)) {
          if (typeof v === 'number' && k !== 'timestamp') directMetrics[k] = v;
        }
        const baseline = Object.keys(metrics).length > 0 ? metrics : directMetrics;
        if (Object.keys(baseline).length > 0) {
          fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
          fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
          this.runtime.log('workflow', 'ensure',
            `[ENSURE-RECOVER] Created baseline.json from experiments.log: ${JSON.stringify(baseline)}`);
          return;
        }
      }
    } catch (err) {
      this.runtime.log('workflow', 'ensure',
        `[ENSURE-RECOVER] Failed to create baseline from log: ${err.message}`);
    }
  }

  enforcePost(post) {
    if (!post.tasks_in) return;

    const dirs = this.runtime.listTaskDirs();

    for (const dir of dirs) {
      try {
        const task = this.runtime.readTask(dir);
        if (!task || task.status !== post.tasks_in) continue;

        const newStatus = this.resolvePostStatus(post, dir);
        if (newStatus && newStatus !== task.status) {
          const updates = { status: newStatus };
          if (newStatus === (post.on_no_evidence || 'review') ||
              newStatus === (post.on_empty_evidence || 'review')) {
            updates.assignee = null;
          }
          this.runtime.updateTaskFields(dir, updates);
          this.runtime.log('workflow', 'post',
            `[POST] ${dir}: ${post.tasks_in} → ${newStatus}`);
        }
      } catch (e) {
        this.runtime.log('error', 'post', `Failed: ${dir}: ${e.message}`);
      }
    }
  }

  resolvePostStatus(post, taskDir) {
    if (post.evidence) {
      const content = this.runtime.readTaskFile(taskDir, post.evidence);
      if (content === null) {
        return post.on_no_evidence || post.fallback_status || 'review';
      }
      if (content.trim().length === 0) {
        return post.on_empty_evidence || post.fallback_status || 'review';
      }
      if (post.on_fail_signal) {
        const lower = content.toLowerCase();
        const sig = post.on_fail_signal;
        const hasSignal = sig.contains && lower.includes(sig.contains);
        const excluded = sig.not_contains && lower.includes(sig.not_contains);
        if (hasSignal && !excluded) {
          return sig.status || post.failure_status || 'blocked';
        }
      }
      // evidence 存在且无 failure signal → success
      return post.success_status || (post.must_become && post.must_become[0]) || null;
    }

    // 无 evidence 要求 → 直接 success
    return post.success_status || (post.must_become && post.must_become[0]) || null;
  }

  // ─── Loop ───

  async executeLoop(node, ctx) {
    const max = node.maxIterations || 100;
    let iteration = 0;

    // ─── Stall Detection ───
    // Track state snapshots to detect loops making no progress.
    // If the state fingerprint is unchanged for N consecutive iterations, exit.
    const stallThreshold = node.stallThreshold || 3;
    let stallCount = 0;
    let lastFingerprint = null;

    while (iteration < max) {
      iteration++;
      this.loopIterations.set(this.currentNode, iteration);
      ctx = this.buildContext();
      ctx.iteration = iteration;
      this.runtime.log('workflow', this.currentNode, `[LOOP] Iteration ${iteration}`);

      // Snapshot state before step execution
      const fingerprint = this._stateFingerprint(ctx);

      // 执行 steps
      if (node.steps) {
        await this.runSteps(node.steps, ctx);
      } else if (node.do) {
        if (typeof node.do === 'function') {
          await node.do(ctx);
        } else if (node.do.steps) {
          await this.runSteps(node.do.steps, ctx);
        }
      }

      // Refresh context after execution
      ctx = this.buildContext();
      ctx.iteration = iteration;
      const postFingerprint = this._stateFingerprint(ctx);

      // ─── Stall check ───
      if (postFingerprint === lastFingerprint) {
        stallCount++;
        this.runtime.log('workflow', this.currentNode,
          `[STALL] No state change (${stallCount}/${stallThreshold})`);
        if (stallCount >= stallThreshold) {
          this.runtime.log('workflow', this.currentNode,
            `[STALL-EXIT] ${stallCount} iterations with no progress — forcing exit`);
          // Follow exit path if defined, otherwise just break
          if (node.stallExit) {
            const target = typeof node.stallExit === 'string' ? node.stallExit : node.stallExit.next;
            if (target) {
              await this.executeNode(target);
              return;
            }
          }
          // Default: follow normal exit.next if available
          if (node.exit) {
            const exitNext = node.exit.next || node.exit.then;
            const target = typeof exitNext === 'string' ? exitNext :
              (exitNext && exitNext.then ? exitNext.then : null);
            if (target) {
              await this.executeNode(target);
              return;
            }
          }
          break;
        }
      } else {
        stallCount = 0;
      }
      lastFingerprint = postFingerprint;

      // 退出条件
      if (node.exit) {
        const target = this.resolveExit(node.exit, ctx);
        if (target && target !== this.currentNode) {
          await this.executeNode(target);
          return;
        }
      }

      // continue 条件
      if (node.continue) {
        if (typeof node.continue === 'function' && !node.continue(ctx)) break;
        if (typeof node.continue === 'string' && !this.evaluate(node.continue, ctx)) break;
      }
    }

    this.runtime.log('workflow', this.currentNode, `[LOOP] Max iterations (${max})`);
  }

  // ─── State Fingerprint for Stall Detection ───
  //
  // Captures: task counts by status, git HEAD, total task count, milestone status.
  // If this string is identical across iterations, nothing meaningful happened.

  _stateFingerprint(ctx) {
    const parts = [];
    // Task counts
    for (const s of ['todo', 'inProgress', 'review', 'testing', 'blocked', 'done']) {
      const key = s + 'Count';
      parts.push(key + ':' + (ctx[key] || 0));
    }
    // Git HEAD
    try {
      const { execSync } = require('child_process');
      const head = execSync('git rev-parse HEAD', {
        cwd: this.runtime.projectDir, timeout: 5000
      }).toString().trim().slice(0, 8);
      parts.push('git:' + head);
    } catch { parts.push('git:?'); }
    // Total tasks and milestone state
    try {
      const totalTasks = this.runtime.listTaskDirs().length;
      parts.push('total:' + totalTasks);
    } catch { parts.push('total:?'); }
    // Experiments.log line count (for autoresearch)
    try {
      const logPath = path.join(this.runtime.projectDir, 'experiments.log');
      if (fs.existsSync(logPath)) {
        const lineCount = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
        parts.push('exp:' + lineCount);
      }
    } catch {}
    return parts.join('|');
  }

  resolveExit(exit, ctx) {
    if (typeof exit === 'function') return exit(ctx);

    if (exit.condition) {
      if (!this.evaluate(exit.condition, ctx)) return null;
      const target = this.resolveNext(exit.next, ctx);
      if (target) {
        this.runtime.log('workflow', this.currentNode, `[EXIT] ${exit.condition} → ${target}`);
      }
      return target;
    }

    if (exit.branches || exit.if) {
      return this.resolveNext(exit, ctx);
    }

    // Legacy: { "condition_expr": "target_node", ... }
    for (const [cond, target] of Object.entries(exit)) {
      if (this.evaluate(cond, ctx)) {
        const resolved = typeof target === 'string' ? target : this.resolveNext(target, ctx);
        this.runtime.log('workflow', this.currentNode, `[EXIT] ${cond} → ${resolved}`);
        return resolved;
      }
    }
    return null;
  }

  // ─── Wait ───

  async executeWait(node, ctx) {
    const pollInterval = node.pollInterval || 10000;
    const maxWait = node.maxWait || 3600000;
    this.runtime.log('workflow', this.currentNode, `[WAIT] ${node.description || 'waiting'}`);

    const self = this;
    let conditionMet = false;
    let timedOut = false;
    const startTime = Date.now();

    const check = function () {
      if (conditionMet) return;
      const fresh = self.buildContext();
      if (node.condition && self.evaluate(node.condition, fresh)) { conditionMet = true; return; }
      if (node.when && self.evaluate(node.when, fresh)) { conditionMet = true; return; }
    };

    this.runtime.on('kanban_updated', check);
    this.runtime.on('agent_complete', check);
    check();

    while (!conditionMet) {
      if (Date.now() - startTime > maxWait) { timedOut = true; break; }
      await new Promise(r => setTimeout(r, pollInterval));
      check();
    }

    this.runtime.off('kanban_updated', check);
    this.runtime.off('agent_complete', check);

    if (conditionMet) {
      await this.followNext(node.next, this.buildContext());
    } else if (timedOut && node.onTimeout) {
      await this.followNext(node.onTimeout, this.buildContext());
    }
  }

  // ─── Reactive ───

  async executeReactive(node, ctx) {
    this.runtime.log('workflow', this.currentNode, '[REACTIVE] Start');
    const running = new Set();
    const self = this;
    let exit = false;
    let processing = false;

    const evaluate = function () {
      if (exit || processing) return;
      processing = true;
      try {
        const fresh = self.buildContext();
        // node.steps: reactive steps with when conditions
        if (node.steps) {
          for (const step of node.steps) {
            const when = step.when || step.trigger;
            if (!when || !self.evaluate(when, fresh)) continue;
            const id = step.id || step.execute?.agent || JSON.stringify(step);
            if (running.has(id)) continue;
            running.add(id);
            self.runReactiveStep(step, fresh, running, id);
          }
        }
        // Legacy: node.agents
        if (node.agents) {
          for (const [name, cfg] of Object.entries(node.agents)) {
            if (cfg.trigger?.condition && self.evaluate(cfg.trigger.condition, fresh)) {
              if (!running.has(name)) {
                running.add(name);
                self.runtime.runAgent(name).finally(() => running.delete(name));
              }
            }
          }
        }
        if (self.shouldExitReactive(node, fresh)) exit = true;
      } finally { processing = false; }
    };

    this.runtime.on('kanban_updated', evaluate);
    this.runtime.on('agent_complete', evaluate);
    evaluate();

    const poll = node.pollInterval || 5000;
    while (!exit) {
      await new Promise(r => setTimeout(r, poll));
      evaluate();
    }

    this.runtime.off('kanban_updated', evaluate);
    this.runtime.off('agent_complete', evaluate);

    while (running.size > 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const target = this.getReactiveExitTarget(node, this.buildContext());
    if (target) await this.executeNode(target);
  }

  async runReactiveStep(step, ctx, running, id) {
    try {
      await this.executeStep(step, ctx);
      if (step.post) this.enforcePost(step.post);
    } finally {
      running.delete(id);
    }
  }

  shouldExitReactive(node, ctx) {
    if (!node.exit || !node.exit.condition) return false;
    return this.evaluate(node.exit.condition, ctx);
  }

  getReactiveExitTarget(node, ctx) {
    if (!node.exit || !node.exit.next) return null;
    return this.resolveNext(node.exit.next, ctx);
  }

  // ─── Node Loading ───

  // Run async functions with concurrency limit
  async _runWithConcurrency(fns) {
    const limit = this._maxConcurrency;
    if (fns.length <= limit) {
      return Promise.all(fns.map(fn => fn()));
    }
    // Chunk into batches
    const results = [];
    for (let i = 0; i < fns.length; i += limit) {
      const batch = fns.slice(i, i + limit);
      const batchResults = await Promise.all(batch.map(fn => fn()));
      results.push(...batchResults);
    }
    return results;
  }

  loadNode(nodeId) {
    if (this.config.workflow.nodes && this.config.workflow.nodes[nodeId]) {
      const node = this.config.workflow.nodes[nodeId];
      return typeof node === 'string' ? this.loadNodeFromFile(node) : node;
    }
    // Fallback: scan workflow-specific configs dir, then legacy path
    const workflowName = this.config._workflow || 'dev-team';
    const wfJsonPath = path.join(__dirname, '../configs', workflowName, 'nodes', `${nodeId}.json`);
    if (fs.existsSync(wfJsonPath)) return JSON.parse(fs.readFileSync(wfJsonPath, 'utf8'));
    const jsonPath = path.join(__dirname, '../configs/nodes', `${nodeId}.json`);
    const jsPath = path.join(__dirname, '../configs/nodes', `${nodeId}.js`);
    if (fs.existsSync(jsPath)) return require(jsPath);
    if (fs.existsSync(jsonPath)) return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return null;
  }

  loadNodeFromFile(filePath) {
    // 1. 项目 .team/ 目录
    const projectPath = path.join(this.runtime.projectDir, '.team', filePath);
    if (fs.existsSync(projectPath)) {
      if (projectPath.endsWith('.js')) {
        delete require.cache[require.resolve(projectPath)];
        return require(projectPath);
      }
      return JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    }
    // 2. workflow 子目录 (configs/<workflow>/)
    const workflowName = this.config._workflow || 'dev-team';
    const wfPath = path.resolve(__dirname, '../configs', workflowName, filePath);
    if (fs.existsSync(wfPath)) {
      if (wfPath.endsWith('.js')) return require(wfPath);
      return JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    }
    // 3. legacy fallback (configs/)
    const fullPath = path.resolve(__dirname, '../configs', filePath);
    if (fs.existsSync(fullPath)) {
      if (fullPath.endsWith('.js')) return require(fullPath);
      return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    }
    this.runtime.log('error', 'loadNode', `Not found: ${filePath}`);
    return null;
  }

  // ─── Context ───

  buildContext() {
    const ctx = {
      node: this.currentNode,
      visitedNodes: [...this.visitedNodes],
      iteration: this.loopIterations.get(this.currentNode) || 0,
      isGroupComplete: () => this.runtime.isGroupComplete(),
      hasArchitecture: () => this.runtime.fileExists('ARCHITECTURE.md'),
      Math,
    };

    // daemon context overrides (from shell step post)
    if (this.runtime._contextOverrides) {
      Object.assign(ctx, this.runtime._contextOverrides);
    }

    // workflow.context 表达式
    const defs = this.config.workflow && this.config.workflow.context;
    if (defs) {
      const api = this.buildContextAPI();
      for (const [key, expr] of Object.entries(defs)) {
        try {
          const fn = new Function('tasks', 'gaps', 'milestones', 'files', `return ${expr}`);
          ctx[key] = fn(api.tasks, api.gaps, api.milestones, api.files);
        } catch (e) {
          this.runtime.log('error', 'ctx', `${key}: ${e.message}`);
          ctx[key] = 0;
        }
      }
    }

    return ctx;
  }

  buildContextAPI() {
    const projectDir = this.runtime.projectDir;
    return {
      tasks: {
        byStatus: (status) => {
          const kanban = this.runtime.getKanban();
          return (kanban[status] || []).map(id => {
            try { return this.runtime.readTask(id) || {}; }
            catch { return {}; }
          });
        },
        all: () => {
          const kanban = this.runtime.getKanban();
          const all = [].concat(
            kanban.todo || [], kanban.inProgress || [], kanban.review || [],
            kanban.testing || [], kanban.done || [], kanban.blocked || []);
          return all.map(id => {
            try { return this.runtime.readTask(id) || {}; }
            catch { return {}; }
          });
        }
      },
      gaps: {
        read: (name) => {
          try { return this.runtime.readGap(name) || { match: 100 }; }
          catch { return { match: 100 }; }
        }
      },
      milestones: {
        active: () => {
          const data = this.runtime.getGroups();
          const ms = (data.groups || data.milestones || []).find(m =>
            m.status === 'active' || m.status === 'ready-for-work' || m.status === 'in-progress');
          const label = (this.config.groups && this.config.groups.label) || 'milestones';
          if (ms) ms.path = path.join('.team', label, ms.id);
          return ms || null;
        },
        all: () => {
          const data = this.runtime.getGroups();
          return data.groups || data.milestones || [];
        }
      },
      files: {
        exists: (p) => this.runtime.fileExists(p)
      }
    };
  }

  // ─── Expression Evaluation ───

  evaluate(expr, ctx) {
    if (typeof expr === 'boolean') return expr;
    if (typeof expr === 'function') return expr(ctx);
    if (typeof expr !== 'string') return false;

    // Condition shortcuts — convenience aliases for common expressions
    const shortcuts = {
      'group_complete': () => ctx.isGroupComplete(),
      'milestone_complete': () => ctx.isGroupComplete(), // backward compat alias
      'milestoneComplete': () => ctx.isGroupComplete(),
      'no-architecture': () => !ctx.hasArchitecture(),
    };
    if (shortcuts[expr]) return shortcuts[expr]();

    try {
      const fn = new Function(...Object.keys(ctx), 'Math', `return ${expr}`);
      return fn(...Object.values(ctx), Math);
    } catch (e) {
      this.runtime.log('error', 'eval', `${expr}: ${e.message}`);
      return false;
    }
  }

  evaluateExpr(expr, ctx) {
    if (typeof expr === 'number') return expr;
    if (typeof expr !== 'string') return 0;
    try {
      const fn = new Function(...Object.keys(ctx), 'Math', `return ${expr}`);
      return fn(...Object.values(ctx), Math) || 0;
    } catch { return 0; }
  }

  // ─── Next / Branch ───

  resolveNext(next, ctx) {
    if (!next) return null;
    if (typeof next === 'string') return next;

    if (next.if) {
      const result = this.evaluate(next.if, ctx);
      const target = result ? next.then : next.else;
      this.runtime.log('workflow', this.currentNode,
        `[BRANCH] ${next.if} → ${result} → ${target || '(end)'}`);
      return target || null;
    }

    if (Array.isArray(next.branches)) {
      for (const b of next.branches) {
        if (this.evaluate(b.condition, ctx)) {
          this.runtime.log('workflow', this.currentNode,
            `[BRANCH] matched: ${b.condition} → ${b.next}`);
          return b.next;
        }
      }
      const fallback = next.default || null;
      this.runtime.log('workflow', this.currentNode,
        `[BRANCH] no match → default: ${fallback || '(end)'}`);
      return fallback;
    }

    return null;
  }

  async followNext(next, ctx) {
    const fresh = next && typeof next === 'object' ? this.buildContext() : ctx;
    const target = this.resolveNext(next, fresh);
    if (target) await this.executeNode(target);
  }
}

module.exports = WorkflowEngine;
