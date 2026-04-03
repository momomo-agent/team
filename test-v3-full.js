#!/usr/bin/env node
// 完整测试 v3.0 workflow

const WorkflowEngine = require('./agents/workflow-engine-v3');
const fs = require('fs');
const path = require('path');

// 加载配置
const config = require('/tmp/team-v3-test/.team/config.json');

// 模拟 daemon
let loopCount = 0;
const mockDaemon = {
  projectDir: '/tmp/team-v3-test',
  maxDevs: 3,
  
  getTodoCount: () => loopCount < 3 ? 5 : 0,
  getTasksWithDesign: () => loopCount < 3 ? 3 : 0,
  getReviewCount: () => loopCount < 3 ? 2 : 0,
  isMilestoneComplete: () => false,
  getKanban: () => ({ todo: [], inProgress: [], review: [], done: [] }),
  getMilestones: () => [],
  
  log: (...args) => console.log('[LOG]', ...args),
  
  runAgent: async (name) => {
    console.log(`  [AGENT] ${name}`);
    if (name === 'pm') loopCount++;  // PM 执行后增加计数
    await new Promise(r => setTimeout(r, 10));
    return { success: true };
  }
};

async function test() {
  console.log('=== Testing v3.0 Complete Workflow ===\n');
  console.log('Config version:', config.version);
  console.log('Entry node:', config.workflow.entry);
  console.log('Nodes:', Object.keys(config.workflow.nodes));
  console.log();
  
  const engine = new WorkflowEngine(config, mockDaemon);
  await engine.execute();
  
  console.log('\n✅ Workflow completed!');
}

test().catch(e => {
  console.error('❌ Error:', e.message);
  console.error(e.stack);
});
