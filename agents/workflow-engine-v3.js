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
      todoCount: this.daemon.getTodoCount(),
      designedTasks: this.daemon.getTasksWithDesign(),
      reviewCount: this.daemon.getReviewCount(),
      maxDevs: this.daemon.maxDevs,

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
      log: (...args) => this.daemon.log('workflow', this.currentNode, ...args)
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
   * 执行 wait 节点
   */
  async executeWait(node, ctx) {
    this.daemon.log('workflow', this.currentNode, `[WAIT] ${node.trigger || 'event'}`);
    // 实际实现可以监听事件
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
        return new Function('ctx', 'Math', `return ${condition}`)(ctx, Math);
      } catch (e) {
        this.daemon.log('error', 'workflow', `Condition eval error: ${condition} - ${e.message}`);
        return false;
      }
    }

    return false;
  }
}

module.exports = WorkflowEngine;
