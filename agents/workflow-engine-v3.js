/**
 * Team v3.0 - 有向图 Workflow 执行引擎
 * 支持混合配置：JSON + JS
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
  }

  /**
   * 执行 workflow
   */
  async execute() {
    const entryNode = this.config.workflow.entry || 'startup';
    await this.executeNode(entryNode);
  }

  /**
   * 执行单个节点
   */
  async executeNode(nodeId) {
    if (!nodeId) return;

    const node = this.loadNode(nodeId);
    if (!node) {
      this.daemon.log('error', 'workflow', `Node not found: ${nodeId}`);
      return;
    }

    this.currentNode = nodeId;
    this.visitedNodes.push(nodeId);
    this.daemon.log('agent_start', nodeId, `[NODE] ${nodeId} - ${node.description || ''}`);

    // 构建 context
    const ctx = this.buildContext();

    // 根据节点类型执行
    switch (node.type) {
      case 'sequence':
        await this.executeSequence(node, ctx);
        if (node.next) await this.executeNode(node.next);
        break;

      case 'loop':
        await this.executeLoop(node, ctx);
        break;

      case 'reactive':
        await this.executeReactive(node, ctx);
        break;

      case 'wait':
        await this.executeWait(node, ctx);
        if (node.next) await this.executeNode(node.next);
        break;

      case 'custom':
        // JS 自定义节点
        if (typeof node.execute === 'function') {
          await node.execute(ctx);
        }
        if (node.next) await this.executeNode(node.next);
        break;
    }
  }

  /**
   * 加载节点（支持 JSON 和 JS）
   */
  loadNode(nodeId) {
    // 1. 从配置的 nodes 对象加载
    if (this.config.workflow.nodes && this.config.workflow.nodes[nodeId]) {
      const node = this.config.workflow.nodes[nodeId];
      
      // 如果是字符串路径，加载文件
      if (typeof node === 'string') {
        return this.loadNodeFromFile(node);
      }
      
      return node;
    }

    // 2. 从 configs/nodes/ 目录加载
    const jsonPath = path.join(__dirname, '../configs/nodes', `${nodeId}.json`);
    const jsPath = path.join(__dirname, '../configs/nodes', `${nodeId}.js`);

    if (fs.existsSync(jsPath)) {
      return require(jsPath);
    }
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }

    return null;
  }

  loadNodeFromFile(filePath) {
    // 1. 先尝试项目目录
    const projectPath = path.join(this.daemon.projectDir, '.team', filePath);
    this.daemon.log('workflow', 'loadNode', `Trying project path: ${projectPath}`);
    if (fs.existsSync(projectPath)) {
      this.daemon.log('workflow', 'loadNode', `Found in project: ${projectPath}`);
      if (projectPath.endsWith('.js')) {
        delete require.cache[require.resolve(projectPath)]; // 清除缓存
        return require(projectPath);
      }
      return JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    }
    
    // 2. 回退到 configs 目录
    const fullPath = path.resolve(__dirname, '../configs', filePath);
    this.daemon.log('workflow', 'loadNode', `Trying configs path: ${fullPath}`);
    if (fs.existsSync(fullPath)) {
      this.daemon.log('workflow', 'loadNode', `Found in configs: ${fullPath}`);
      if (fullPath.endsWith('.js')) {
        return require(fullPath);
      }
      return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    }
    
    this.daemon.log('error', 'loadNode', `Node file not found: ${filePath}`);
    return null;
  }

  /**
   * 构建执行上下文
   */
  buildContext() {
    const ctx = {
      // 通用字段
      node: this.currentNode,
      visitedNodes: [...this.visitedNodes],
      iteration: this.loopIterations.get(this.currentNode) || 0,

      // 场景数据（dev-team）
      todoCount: this.daemon.getTodoCount() || 0,
      designedTasks: this.daemon.getTasksWithDesign() || 0,
      reviewCount: this.daemon.getReviewCount() || 0,
      doneCount: this.daemon.getDoneCount() || 0,
      inProgressCount: this.daemon.getInProgressCount ? this.daemon.getInProgressCount() : 0,
      testingCount: this.daemon.getTestingCount ? this.daemon.getTestingCount() : 0,
      maxDevs: this.daemon.maxDevs || 3,

      // 状态检查
      isMilestoneComplete: () => this.daemon.isMilestoneComplete(),
      hasArchitecture: () => fs.existsSync(path.join(this.daemon.projectDir, 'ARCHITECTURE.md')),

      // 数据访问
      kanban: () => this.daemon.getKanban(),
      milestones: () => this.daemon.getMilestones(),

      // Agent 执行
      runAgent: (name) => this.daemon.runAgent(name),
      runAgents: (names, parallel = false) => {
        if (parallel) {
          return Promise.all(names.map(n => this.daemon.runAgent(n)));
        }
        return names.reduce((p, n) => p.then(() => this.daemon.runAgent(n)), Promise.resolve());
      },

      // 工具
      Math,
      Date,
      log: (...args) => this.daemon.log('workflow', this.currentNode, ...args),
      
      // v2.0 对齐：检查 CR 和 stuck tasks
      checkPendingCRs: () => this.daemon.checkPendingCRs && this.daemon.checkPendingCRs(),
      checkStuckTasks: () => this.daemon.checkStuckTasks && this.daemon.checkStuckTasks()
    };

    return ctx;
  }

  /**
   * 执行 sequence 节点
   */
  async executeSequence(node, ctx) {
    const steps = node.steps || [];

    for (const step of steps) {
      // 检查条件
      if (step.condition && !this.evaluateCondition(step.condition, ctx)) {
        this.daemon.log('workflow', this.currentNode, `[SKIP] Condition not met: ${step.condition}`);
        continue;
      }

      // 执行 agents
      if (step.agents) {
        if (step.parallel) {
          this.daemon.log('workflow', this.currentNode, `[PARALLEL] ${step.agents.join(', ')}`);
          await Promise.all(step.agents.map(a => this.daemon.runAgent(a)));
        } else {
          for (const agent of step.agents) {
            await this.daemon.runAgent(agent);
          }
        }
      }

      // 自定义执行函数
      if (typeof step.execute === 'function') {
        await step.execute(ctx);
      }
    }
  }

  /**
   * 执行 loop 节点
   */
  async executeLoop(node, ctx) {
    const maxIterations = node.maxIterations || 100;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      this.loopIterations.set(this.currentNode, iteration);
      ctx.iteration = iteration;

      this.daemon.log('workflow', this.currentNode, `[LOOP] Iteration ${iteration}`);

      // 执行 do 部分
      if (node.do) {
        if (typeof node.do === 'function') {
          // JS 函数
          await node.do(ctx);
        } else if (node.do.type === 'sequence') {
          // JSON sequence
          await this.executeSequence(node.do, ctx);
        } else if (node.do.steps) {
          // 简化的 steps
          await this.executeSequence(node.do, ctx);
        }
      }

      // 检查退出条件
      if (node.exit) {
        let exitTarget = null;

        if (typeof node.exit === 'function') {
          // JS 函数返回目标节点
          exitTarget = node.exit(ctx);
        } else {
          // JSON 条件映射
          for (const [condition, target] of Object.entries(node.exit)) {
            if (this.evaluateCondition(condition, ctx)) {
              exitTarget = target;
              this.daemon.log('workflow', this.currentNode, `[EXIT] ${condition} → ${target}`);
              break;
            }
          }
        }

        if (exitTarget && exitTarget !== this.currentNode) {
          await this.executeNode(exitTarget);
          return;
        }
      }

      // 检查 continue 条件
      if (node.continue) {
        if (typeof node.continue === 'function') {
          if (!node.continue(ctx)) break;
        } else if (typeof node.continue === 'string') {
          if (!this.evaluateCondition(node.continue, ctx)) break;
        }
      }
    }

    this.daemon.log('workflow', this.currentNode, `[LOOP] Max iterations reached`);
  }

  /**
   * 执行 reactive 节点（事件驱动 + 轮询看护）
   */
  async executeReactive(node, ctx) {
    this.daemon.log('workflow', this.currentNode, '[REACTIVE] Starting event-driven workflow');
    
    const runningAgents = new Set();
    const self = this;
    let exitRequested = false;
    
    // 事件处理器：重新评估所有 agent 触发条件
    const evaluateTriggers = () => {
      if (exitRequested) return;
      
      const freshCtx = self.buildContext();
      for (const [agentName, agentConfig] of Object.entries(node.agents)) {
        if (self.shouldTriggerAgent(agentConfig, freshCtx, null)) {
          const alreadyRunning = runningAgents.has(agentName) || 
                                 Array.from(runningAgents).some(a => a.startsWith(agentName + '-'));
          if (!alreadyRunning) {
            self.daemon.log('workflow', self.currentNode, `[REACTIVE] Event triggered: ${agentName}`);
            self.runReactiveAgent(agentName, agentConfig, freshCtx, runningAgents);
          }
        }
      }
      
      // 检查退出条件
      if (self.shouldExitReactive(node, freshCtx)) {
        self.daemon.log('workflow', self.currentNode, '[REACTIVE] Exit condition met');
        exitRequested = true;
      }
    };
    
    // 监听事件
    this.daemon.on('kanban_updated', evaluateTriggers);
    this.daemon.on('agent_complete', evaluateTriggers);
    this.daemon.on('cr_changed', evaluateTriggers);
    
    // 初始触发
    evaluateTriggers();
    
    // 轮询看护（60秒检查超时/卡死）
    const watchdogInterval = setInterval(() => {
      if (exitRequested) return;
      
      self.daemon.log('workflow', self.currentNode, '[REACTIVE] Watchdog: checking for timeouts');
      
      // 检查是否有 agent 超时（这里简化处理，实际超时由 daemon 的 AGENT_TIMEOUT 处理）
      if (runningAgents.size === 0) {
        evaluateTriggers(); // 没有运行中的 agent，重新评估
      }
    }, 60000);
    
    // 等待退出条件
    while (!exitRequested) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 如果没有运行中的 agent 且退出条件满足，退出
      if (runningAgents.size === 0 && this.shouldExitReactive(node, this.buildContext())) {
        exitRequested = true;
      }
    }
    
    // 清理
    clearInterval(watchdogInterval);
    this.daemon.off('kanban_updated', evaluateTriggers);
    this.daemon.off('agent_complete', evaluateTriggers);
    this.daemon.off('cr_changed', evaluateTriggers);
    
    // 等待所有 agent 完成
    while (runningAgents.size > 0) {
      this.daemon.log('workflow', this.currentNode, `[REACTIVE] Waiting for ${runningAgents.size} agents to complete`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 执行退出逻辑
    const exitTarget = this.getReactiveExitTarget(node, this.buildContext());
    if (exitTarget) {
      await this.executeNode(exitTarget);
    }
  }
  
  /**
   * 运行 reactive agent（异步，不阻塞）
   */
  async runReactiveAgent(agentName, agentConfig, ctx, runningAgents) {
    const agentId = agentName + '-' + Date.now();
    runningAgents.add(agentId);
    
    try {
      await this.daemon.runAgent(agentName);
    } finally {
      runningAgents.delete(agentId);
    }
  }

  /**
   * 执行 wait 节点（轮询模式）
   */
  async executeWait(node, ctx) {
    const pollInterval = node.pollInterval || 10000; // 默认 10 秒轮询一次
    const maxWait = node.maxWait || 3600000; // 默认最多等待 1 小时
    
    this.daemon.log('workflow', this.currentNode, `[WAIT] Polling for: ${node.trigger || 'condition'}`);
    
    const startTime = Date.now();
    
    while (true) {
      // 刷新 context
      ctx = this.buildContext();
      
      // 检查触发条件
      if (node.condition && this.evaluateCondition(node.condition, ctx)) {
        this.daemon.log('workflow', this.currentNode, '[WAIT] Condition met, continuing...');
        break;
      }
      
      // 检查是否有新任务（通用触发条件）
      if (node.trigger === 'new_task' && ctx.todoCount > 0) {
        this.daemon.log('workflow', this.currentNode, '[WAIT] New task detected, continuing...');
        break;
      }
      
      // 超时检查
      if (Date.now() - startTime > maxWait) {
        this.daemon.log('workflow', this.currentNode, '[WAIT] Max wait time reached, exiting...');
        return; // 超时退出，不继续执行
      }
      
      // 等待后再检查
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    // 条件满足，继续执行 next 节点
    if (node.next) {
      await this.executeNode(node.next);
    }
  }

  /**
   * 条件评估器（支持简单条件和 JS 表达式）
   */
  evaluateCondition(condition, ctx) {
    if (typeof condition === 'boolean') {
      return condition;
    }

    if (typeof condition === 'function') {
      return condition(ctx);
    }

    if (typeof condition === 'string') {
      // 预定义条件
      const predefined = {
        'no-architecture': () => !ctx.hasArchitecture(),
        'milestone_complete': () => ctx.isMilestoneComplete(),
        'no_work': () => ctx.todoCount === 0 && ctx.reviewCount === 0,
        'has_work': () => ctx.todoCount > 0 || ctx.reviewCount > 0
      };

      if (predefined[condition]) {
        return predefined[condition]();
      }

      // JS 表达式
      try {
        // 将 ctx 的属性解构到作用域中，这样可以直接用 todoCount 而不是 ctx.todoCount
        const fn = new Function(...Object.keys(ctx), 'Math', `return ${condition}`);
        return fn(...Object.values(ctx), Math);
      } catch (e) {
        // 条件评估失败，静默返回 false（避免日志爆炸）
        this.daemon.log('error', 'evaluateCondition', `Failed to evaluate: ${condition}, error: ${e.message}`);
        return false;
      }
    }

    return false;
  }

  /**
   * 检查是否应该触发 agent
   */
  shouldTriggerAgent(agentConfig, ctx, event) {
    if (!agentConfig.trigger) return false;
    
    // 基于事件触发
    if (agentConfig.trigger.on_event && event) {
      return agentConfig.trigger.on_event.includes(event.type);
    }
    
    // 基于条件触发
    if (agentConfig.trigger.condition) {
      const result = this.evaluateCondition(agentConfig.trigger.condition, ctx);
      // 调试日志
      if (result) {
        this.daemon.log('workflow', this.currentNode, `[TRIGGER] Condition met: ${agentConfig.trigger.condition}`);
      }
      return result;
    }
    
    return false;
  }

  /**
   * 处理 reactive 事件
   */
  async handleReactiveEvent(event, node, ctx, runningAgents, eventQueue) {
    if (event.type === 'trigger') {
      const agentName = event.agent;
      const agentConfig = node.agents[agentName];
      
      // 检查并发限制
      if (agentConfig.scalable) {
        const max = agentConfig.max || ctx.maxDevs || 3;
        const running = Array.from(runningAgents).filter(a => a.startsWith(agentName)).length;
        
        if (running >= max) {
          this.daemon.log('workflow', this.currentNode, `[REACTIVE] ${agentName} at max concurrency (${max})`);
          return;
        }
        
        // 启动多个实例
        const count = Math.min(max - running, this.getAgentDemand(agentName, ctx));
        for (let i = 1; i <= count; i++) {
          const instanceName = `${agentName}-${i}`;
          if (!runningAgents.has(instanceName)) {
            runningAgents.add(instanceName);
            this.runAgentAsync(instanceName, agentConfig, ctx, runningAgents, eventQueue);
          }
        }
      } else {
        // 单实例 agent
        if (!runningAgents.has(agentName)) {
          runningAgents.add(agentName);
          this.runAgentAsync(agentName, agentConfig, ctx, runningAgents, eventQueue);
        }
      }
    }
  }

  /**
   * 异步运行 agent
   */
  async runAgentAsync(agentName, agentConfig, ctx, runningAgents, eventQueue) {
    try {
      await this.daemon.runAgent(agentName);
      
      // Agent 完成，触发 on_complete 事件
      if (agentConfig.on_complete) {
        for (const nextAgent of agentConfig.on_complete) {
          eventQueue.push({ type: 'trigger', agent: nextAgent });
        }
      }
    } catch (err) {
      this.daemon.log('error', agentName, `Agent failed: ${err.message}`);
    } finally {
      runningAgents.delete(agentName);
    }
  }

  /**
   * 获取 agent 需求数量
   */
  getAgentDemand(agentName, ctx) {
    if (agentName === 'developer') {
      return ctx.designedTasks || 0;
    } else if (agentName === 'tester') {
      return ctx.reviewCount || 0;
    }
    return 1;
  }

  /**
   * 检查是否应该退出 reactive 循环
   */
  shouldExitReactive(node, ctx) {
    if (!node.exit || !node.exit.condition) return false;
    return this.evaluateCondition(node.exit.condition, ctx);
  }

  /**
   * 获取 reactive 退出目标
   */
  getReactiveExitTarget(node, ctx) {
    if (!node.exit || !node.exit.next) return null;
    
    const next = node.exit.next;
    if (typeof next === 'string') return next;
    
    // 条件分支
    if (next.if && this.evaluateCondition(next.if, ctx)) {
      return next.then;
    }
    return next.else || null;
  }
}

module.exports = WorkflowEngine;
