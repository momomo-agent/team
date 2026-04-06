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

class WorkflowEngine {
  constructor(config, daemon) {
    this.config = config;
    this.daemon = daemon;
    this.currentNode = null;
    this.visitedNodes = [];
    this.loopIterations = new Map();
    this.transitionDepth = 0;
    this.maxTransitions = (config.workflow && config.workflow.maxTransitions) || 10000;
  }

  // ─── Workflow Entry ───

  async execute() {
    const entry = this.config.workflow.entry || 'startup';
    await this.executeNode(entry);
  }

  // ─── Node Execution ───

  async executeNode(nodeId) {
    if (!nodeId) return;

    this.transitionDepth++;
    if (this.transitionDepth > this.maxTransitions) {
      this.daemon.log('error', 'workflow',
        `[ABORT] Max transitions (${this.maxTransitions}). Last: ${nodeId}`);
      return;
    }

    const node = this.loadNode(nodeId);
    if (!node) {
      this.daemon.log('error', 'workflow', `Node not found: ${nodeId}`);
      return;
    }

    this.currentNode = nodeId;
    this.visitedNodes.push(nodeId);
    this.daemon.log('agent_start', nodeId, `[NODE] ${nodeId} - ${node.description || ''}`);

    const ctx = this.buildContext();

    switch (node.type) {
      case 'sequence':
        await this.runSteps(node.steps, ctx);
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

  async runSteps(steps, ctx) {
    if (!steps) return;

    for (const step of steps) {
      // 前置条件
      const when = step.when || step.trigger || step.condition;
      if (when && !this.evaluate(when, ctx)) {
        this.daemon.log('workflow', this.currentNode,
          `[SKIP] ${step.id || step.execute?.agent || '?'}: ${when}`);
        continue;
      }

      // 执行
      await this.executeStep(step, ctx);

      // 后置保证
      if (step.post) {
        this.enforcePost(step.post);
      }

      // step 可能改变了世界状态，刷新 context
      Object.assign(ctx, this.buildContext());
    }
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
        if (typeof exec.fn === 'function') await exec.fn(ctx);
        break;
    }
  }

  async executeStepAgent(exec, step, ctx) {
    const agent = exec.agent;
    const parallel = exec.parallel || 1;

    if (parallel <= 1) {
      // 串行：demand 决定跑几次
      const demand = step.demand ? this.evaluateExpr(step.demand, ctx) : 1;
      const count = Math.max(1, Math.min(demand, 1)); // 串行最多 1
      this.daemon.log('workflow', this.currentNode, `[EXEC] ${agent}`);
      await this.daemon.runAgent(agent);
    } else {
      // 并行
      const demand = step.demand ? this.evaluateExpr(step.demand, ctx) : 1;
      const count = Math.min(demand, parallel);
      if (count <= 0) {
        this.daemon.log('workflow', this.currentNode, `[SKIP] ${agent}: demand=0`);
        return;
      }
      if (count === 1) {
        this.daemon.log('workflow', this.currentNode, `[EXEC] ${agent}`);
        await this.daemon.runAgent(agent);
      } else {
        const instances = [];
        for (let i = 1; i <= count; i++) instances.push(`${agent}-${i}`);
        this.daemon.log('workflow', this.currentNode, `[PARALLEL] ${instances.join(', ')}`);
        await Promise.all(instances.map(a => this.daemon.runAgent(a)));
      }
    }
  }

  async executeStepShell(exec, step, ctx) {
    const { execSync } = require('child_process');
    const cwd = exec.cwd
      ? exec.cwd.replace('{{projectDir}}', this.daemon.projectDir)
      : this.daemon.projectDir;
    const cmd = exec.command;
    this.daemon.log('workflow', this.currentNode, `[SHELL] ${cmd}`);
    try {
      const output = execSync(cmd, { cwd, stdio: 'pipe', timeout: exec.timeout || 60000 });
      if (step.post && step.post.on_exit_0) {
        this.applyContextOverrides(step.post.on_exit_0);
      }
    } catch (e) {
      this.daemon.log('error', this.currentNode, `[SHELL] exit ${e.status}: ${e.message}`);
      if (step.post && step.post.on_exit_nonzero) {
        this.applyContextOverrides(step.post.on_exit_nonzero);
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
      this.daemon.log('workflow', this.currentNode, `[PARALLEL] ${agents.join(', ')}`);
      await Promise.all(agents.map(a => this.daemon.runAgent(a)));
    } else {
      for (const agent of agents) {
        this.daemon.log('workflow', this.currentNode, `[EXEC] ${agent}`);
        await this.daemon.runAgent(agent);
      }
    }
  }

  applyContextOverrides(overrides) {
    if (overrides && overrides.set_context) {
      // 写入 daemon 的共享状态（简单 key-value）
      if (!this.daemon._contextOverrides) this.daemon._contextOverrides = {};
      Object.assign(this.daemon._contextOverrides, overrides.set_context);
    }
  }

  // ─── Postcondition Enforcement ───

  enforcePost(post) {
    if (!post.tasks_in) return;

    const tasksDir = path.join(this.daemon.projectDir, '.team/tasks');
    if (!fs.existsSync(tasksDir)) return;

    const dirs = fs.readdirSync(tasksDir).filter(d =>
      fs.existsSync(path.join(tasksDir, d, 'task.json'))
    );

    for (const dir of dirs) {
      const taskPath = path.join(tasksDir, dir, 'task.json');
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        if (task.status !== post.tasks_in) continue;

        const newStatus = this.resolvePostStatus(post, path.join(tasksDir, dir));
        if (newStatus && newStatus !== task.status) {
          task.status = newStatus;
          if (newStatus === (post.on_no_evidence || 'review') ||
              newStatus === (post.on_empty_evidence || 'review')) {
            task.assignee = null; // unclaim on fallback
          }
          fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
          this.daemon.log('workflow', 'post',
            `[POST] ${dir}: ${post.tasks_in} → ${newStatus}`);
        }
      } catch (e) {
        this.daemon.log('error', 'post', `Failed: ${dir}: ${e.message}`);
      }
    }
  }

  resolvePostStatus(post, taskDir) {
    // 有 evidence 要求
    if (post.evidence) {
      const evidencePath = path.join(taskDir, post.evidence);
      if (!fs.existsSync(evidencePath)) {
        return post.on_no_evidence || post.fallback_status || 'review';
      }
      const content = fs.readFileSync(evidencePath, 'utf8');
      if (content.trim().length === 0) {
        return post.on_empty_evidence || post.fallback_status || 'review';
      }
      // 检查 failure signal
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

    while (iteration < max) {
      iteration++;
      this.loopIterations.set(this.currentNode, iteration);
      ctx = this.buildContext();
      ctx.iteration = iteration;
      this.daemon.log('workflow', this.currentNode, `[LOOP] Iteration ${iteration}`);

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

    this.daemon.log('workflow', this.currentNode, `[LOOP] Max iterations (${max})`);
  }

  resolveExit(exit, ctx) {
    if (typeof exit === 'function') return exit(ctx);

    if (exit.condition) {
      if (!this.evaluate(exit.condition, ctx)) return null;
      const target = this.resolveNext(exit.next, ctx);
      if (target) {
        this.daemon.log('workflow', this.currentNode, `[EXIT] ${exit.condition} → ${target}`);
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
        this.daemon.log('workflow', this.currentNode, `[EXIT] ${cond} → ${resolved}`);
        return resolved;
      }
    }
    return null;
  }

  // ─── Wait ───

  async executeWait(node, ctx) {
    const pollInterval = node.pollInterval || 10000;
    const maxWait = node.maxWait || 3600000;
    this.daemon.log('workflow', this.currentNode, `[WAIT] ${node.description || 'waiting'}`);

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

    this.daemon.on('kanban_updated', check);
    this.daemon.on('agent_complete', check);
    check();

    while (!conditionMet) {
      if (Date.now() - startTime > maxWait) { timedOut = true; break; }
      await new Promise(r => setTimeout(r, pollInterval));
      check();
    }

    this.daemon.off('kanban_updated', check);
    this.daemon.off('agent_complete', check);

    if (conditionMet) {
      await this.followNext(node.next, this.buildContext());
    } else if (timedOut && node.onTimeout) {
      await this.followNext(node.onTimeout, this.buildContext());
    }
  }

  // ─── Reactive ───

  async executeReactive(node, ctx) {
    this.daemon.log('workflow', this.currentNode, '[REACTIVE] Start');
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
                self.daemon.runAgent(name).finally(() => running.delete(name));
              }
            }
          }
        }
        if (self.shouldExitReactive(node, fresh)) exit = true;
      } finally { processing = false; }
    };

    this.daemon.on('kanban_updated', evaluate);
    this.daemon.on('agent_complete', evaluate);
    evaluate();

    const poll = node.pollInterval || 5000;
    while (!exit) {
      await new Promise(r => setTimeout(r, poll));
      evaluate();
    }

    this.daemon.off('kanban_updated', evaluate);
    this.daemon.off('agent_complete', evaluate);

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
    const projectPath = path.join(this.daemon.projectDir, '.team', filePath);
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
    this.daemon.log('error', 'loadNode', `Not found: ${filePath}`);
    return null;
  }

  // ─── Context ───

  buildContext() {
    const ctx = {
      node: this.currentNode,
      visitedNodes: [...this.visitedNodes],
      iteration: this.loopIterations.get(this.currentNode) || 0,
      isMilestoneComplete: () => this.daemon.isMilestoneComplete(),
      hasArchitecture: () => fs.existsSync(path.join(this.daemon.projectDir, 'ARCHITECTURE.md')),
      Math,
    };

    // daemon context overrides (from shell step post)
    if (this.daemon._contextOverrides) {
      Object.assign(ctx, this.daemon._contextOverrides);
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
          this.daemon.log('error', 'ctx', `${key}: ${e.message}`);
          ctx[key] = 0;
        }
      }
    }

    return ctx;
  }

  buildContextAPI() {
    const projectDir = this.daemon.projectDir;
    return {
      tasks: {
        byStatus: (status) => {
          const kanban = this.daemon.getKanban();
          return (kanban[status] || []).map(id => {
            try {
              return JSON.parse(fs.readFileSync(
                path.join(projectDir, '.team/tasks', id, 'task.json'), 'utf8'));
            } catch { return {}; }
          });
        },
        all: () => {
          const kanban = this.daemon.getKanban();
          const all = [].concat(
            kanban.todo || [], kanban.inProgress || [], kanban.review || [],
            kanban.testing || [], kanban.done || [], kanban.blocked || []);
          return all.map(id => {
            try {
              return JSON.parse(fs.readFileSync(
                path.join(projectDir, '.team/tasks', id, 'task.json'), 'utf8'));
            } catch { return {}; }
          });
        }
      },
      gaps: {
        read: (name) => {
          try {
            return JSON.parse(fs.readFileSync(
              path.join(projectDir, '.team/gaps', name + '.json'), 'utf8'));
          } catch { return { match: 100 }; }
        }
      },
      milestones: {
        active: () => {
          const data = this.daemon.getMilestones();
          const ms = (data.milestones || []).find(m =>
            m.status === 'active' || m.status === 'ready-for-work' || m.status === 'in-progress');
          if (ms) ms.path = path.join('.team/milestones', ms.id);
          return ms || null;
        },
        all: () => {
          const data = this.daemon.getMilestones();
          return data.milestones || [];
        }
      },
      files: {
        exists: (p) => fs.existsSync(path.join(projectDir, p))
      }
    };
  }

  // ─── Expression Evaluation ───

  evaluate(expr, ctx) {
    if (typeof expr === 'boolean') return expr;
    if (typeof expr === 'function') return expr(ctx);
    if (typeof expr !== 'string') return false;

    // 预定义快捷名
    const shortcuts = {
      'milestone_complete': () => ctx.isMilestoneComplete(),
      'no-architecture': () => !ctx.hasArchitecture(),
    };
    if (shortcuts[expr]) return shortcuts[expr]();

    try {
      const fn = new Function(...Object.keys(ctx), 'Math', `return ${expr}`);
      return fn(...Object.values(ctx), Math);
    } catch (e) {
      this.daemon.log('error', 'eval', `${expr}: ${e.message}`);
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
      this.daemon.log('workflow', this.currentNode,
        `[BRANCH] ${next.if} → ${result} → ${target || '(end)'}`);
      return target || null;
    }

    if (Array.isArray(next.branches)) {
      for (const b of next.branches) {
        if (this.evaluate(b.condition, ctx)) {
          this.daemon.log('workflow', this.currentNode,
            `[BRANCH] matched: ${b.condition} → ${b.next}`);
          return b.next;
        }
      }
      const fallback = next.default || null;
      this.daemon.log('workflow', this.currentNode,
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
