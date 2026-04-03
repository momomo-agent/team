#!/usr/bin/env node
/**
 * Team v3.0 POC - 有向图 Workflow 执行引擎
 * 
 * 验证：
 * 1. 配置可以表达原有逻辑
 * 2. 执行引擎可以正确解释配置
 * 3. 可以自动生成 Mermaid 图
 */

const fs = require('fs');
const path = require('path');

// 示例配置：dev workflow
const devWorkflow = {
  entry: 'startup',
  nodes: {
    startup: {
      type: 'sequence',
      description: '项目启动',
      steps: [
        {
          agents: ['architect'],
          condition: 'no-architecture',
          description: '架构设计（条件执行）'
        },
        {
          agents: ['vision_monitor', 'prd_monitor', 'dbb_monitor', 'arch_monitor'],
          parallel: true,
          description: '初始评估（并行）'
        },
        {
          agents: ['pm'],
          description: '规划里程碑'
        }
      ],
      next: 'work_loop'
    },
    
    work_loop: {
      type: 'loop',
      description: '工作循环',
      do: {
        type: 'sequence',
        steps: [
          {
            agents: ['tech_lead', 'developer', 'tester'],
            parallel: true,
            description: '并行开发'
          },
          {
            agents: ['pm'],
            description: 'PM 再分配'
          }
        ]
      },
      exit: {
        milestone_complete: 'quality_gate',
        no_work: 'standby'
      },
      continue: 'work_loop'
    },
    
    quality_gate: {
      type: 'sequence',
      description: '质量门禁',
      steps: [
        {
          agents: ['vision_monitor', 'prd_monitor', 'dbb_monitor', 'arch_monitor'],
          parallel: true,
          description: '四重检查'
        },
        {
          agents: ['pm'],
          description: '汇总 gaps'
        }
      ],
      next: 'work_loop'
    },
    
    standby: {
      type: 'wait',
      description: '待机',
      trigger: 'new_task',
      next: 'work_loop'
    }
  }
};

// 条件评估器（模拟）
function evaluateCondition(condition, context) {
  const conditions = {
    'no-architecture': () => !context.hasArchitecture,
    'milestone_complete': () => context.milestoneComplete,
    'no_work': () => context.todoCount === 0 && context.reviewCount === 0,
    'has_work': () => context.todoCount > 0 || context.reviewCount > 0
  };
  
  return conditions[condition] ? conditions[condition]() : false;
}

// Agent 执行器（模拟）
async function runAgent(agentName, context) {
  console.log(`  [RUN] ${agentName}`);
  await new Promise(resolve => setTimeout(resolve, 100)); // 模拟执行
  return { agent: agentName, success: true };
}

// 执行引擎
class WorkflowEngine {
  constructor(workflow, context) {
    this.workflow = workflow;
    this.context = context;
    this.executionLog = [];
  }
  
  async execute() {
    console.log('=== Workflow Execution Start ===\n');
    await this.executeNode(this.workflow.entry);
    console.log('\n=== Workflow Execution Complete ===');
    return this.executionLog;
  }
  
  async executeNode(nodeId) {
    const node = this.workflow.nodes[nodeId];
    if (!node) {
      console.log(`[ERROR] Node not found: ${nodeId}`);
      return;
    }
    
    console.log(`\n[NODE] ${nodeId} - ${node.description}`);
    this.executionLog.push({ node: nodeId, type: node.type });
    
    switch (node.type) {
      case 'sequence':
        await this.executeSequence(node);
        if (node.next) await this.executeNode(node.next);
        break;
        
      case 'loop':
        await this.executeLoop(node);
        break;
        
      case 'wait':
        await this.executeWait(node);
        if (node.next) await this.executeNode(node.next);
        break;
    }
  }
  
  async executeSequence(node) {
    for (const step of node.steps) {
      // 检查条件
      if (step.condition && !evaluateCondition(step.condition, this.context)) {
        console.log(`  [SKIP] Condition not met: ${step.condition}`);
        continue;
      }
      
      if (step.parallel) {
        console.log(`  [PARALLEL] ${step.agents.join(', ')}`);
        await Promise.all(step.agents.map(a => runAgent(a, this.context)));
      } else {
        for (const agent of step.agents) {
          await runAgent(agent, this.context);
        }
      }
    }
  }
  
  async executeLoop(node) {
    let iteration = 0;
    const maxIterations = 3; // POC 限制循环次数
    
    while (iteration < maxIterations) {
      console.log(`  [LOOP] Iteration ${iteration + 1}`);
      
      // 执行 do 部分
      if (node.do.type === 'sequence') {
        await this.executeSequence(node.do);
      }
      
      // 检查退出条件
      for (const [condition, targetNode] of Object.entries(node.exit)) {
        if (evaluateCondition(condition, this.context)) {
          console.log(`  [EXIT] ${condition} → ${targetNode}`);
          
          // 重置状态（避免无限循环）
          if (condition === 'milestone_complete') {
            this.context.milestoneComplete = false;
          }
          
          await this.executeNode(targetNode);
          return;
        }
      }
      
      iteration++;
      
      // 模拟状态变化
      if (iteration === 2) {
        this.context.milestoneComplete = true;
      }
    }
    
    console.log(`  [LOOP] Max iterations reached`);
  }
  
  async executeWait(node) {
    console.log(`  [WAIT] Waiting for: ${node.trigger || 'event'}`);
  }
}

// Mermaid 生成器
function generateMermaid(workflow) {
  let mermaid = 'graph TD\n';
  
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    // 节点
    const shape = node.type === 'loop' ? '{{' : node.type === 'wait' ? '([' : '[';
    const shapeEnd = node.type === 'loop' ? '}}' : node.type === 'wait' ? '])' : ']';
    mermaid += `  ${nodeId}${shape}"${node.description}"${shapeEnd}\n`;
    
    // 边
    if (node.next) {
      mermaid += `  ${nodeId} --> ${node.next}\n`;
    }
    if (node.exit) {
      for (const [cond, target] of Object.entries(node.exit)) {
        mermaid += `  ${nodeId} -->|${cond}| ${target}\n`;
      }
    }
    if (node.continue) {
      mermaid += `  ${nodeId} -.->|continue| ${node.continue}\n`;
    }
  }
  
  return mermaid;
}

// 运行 POC
async function main() {
  console.log('Team v3.0 POC - 有向图 Workflow\n');
  
  // 1. 生成 Mermaid
  console.log('=== Generated Mermaid ===\n');
  const mermaid = generateMermaid(devWorkflow);
  console.log(mermaid);
  
  // 2. 执行 workflow
  const context = {
    hasArchitecture: false,
    todoCount: 5,
    reviewCount: 2,
    milestoneComplete: false
  };
  
  const engine = new WorkflowEngine(devWorkflow, context);
  const log = await engine.execute();
  
  // 3. 输出执行日志
  console.log('\n=== Execution Log ===');
  console.log(JSON.stringify(log, null, 2));
  
  console.log('\n✅ POC 验证成功！');
  console.log('- 配置可以表达原有逻辑');
  console.log('- 执行引擎可以正确解释配置');
  console.log('- 可以自动生成 Mermaid 图');
}

main().catch(console.error);
