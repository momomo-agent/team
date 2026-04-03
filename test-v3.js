#!/usr/bin/env node
// 简单测试 v3.0 引擎

const WorkflowEngine = require('./agents/workflow-engine-v3');

// 模拟 daemon
const mockDaemon = {
  projectDir: '/tmp/team-v3-test',
  maxDevs: 3,
  
  getTodoCount: () => 5,
  getTasksWithDesign: () => 3,
  getReviewCount: () => 2,
  isMilestoneComplete: () => false,
  
  log: (...args) => console.log('[LOG]', ...args),
  
  runAgent: async (name) => {
    console.log(`  [AGENT] ${name}`);
    return { success: true };
  }
};

// 简单配置
const config = {
  version: '3.0',
  workflow: {
    entry: 'test',
    nodes: {
      test: {
        type: 'sequence',
        description: '测试节点',
        steps: [
          { agents: ['agent1'] },
          { agents: ['agent2', 'agent3'], parallel: true }
        ]
      }
    }
  }
};

async function test() {
  console.log('=== Testing WorkflowEngine v3.0 ===\n');
  
  const engine = new WorkflowEngine(config, mockDaemon);
  await engine.execute();
  
  console.log('\n✅ Test completed!');
}

test().catch(console.error);
