#!/usr/bin/env node
/**
 * 测试 reactive 节点修复
 * 验证：
 * 1. reactive 节点可以通过轮询响应状态变化
 * 2. standby 节点可以被唤醒
 */

const WorkflowEngine = require('./agents/workflow-engine-v3');

// 模拟 daemon
let todoCount = 0;
let designedTasks = 0;
let reviewCount = 0;

const mockDaemon = {
  projectDir: '/tmp/team-test',
  maxDevs: 3,
  
  getTodoCount: () => todoCount,
  getTasksWithDesign: () => designedTasks,
  getReviewCount: () => reviewCount,
  getDoneCount: () => 0,
  getInProgressCount: () => 0,
  getTestingCount: () => 0,
  
  log: (...args) => console.log(`[${new Date().toISOString().substr(11,8)}]`, ...args),
  
  runAgent: async (name) => {
    console.log(`  ✅ [AGENT] ${name} STARTED`);
    await new Promise(r => setTimeout(r, 100));
    
    // 模拟 agent 行为
    if (name === 'tech_lead') {
      designedTasks = todoCount;
      todoCount = 0; // tech_lead 处理后清空 todo
      console.log(`  ✅ [AGENT] tech_lead designed ${designedTasks} tasks`);
    } else if (name.startsWith('developer')) {
      if (designedTasks > 0) {
        designedTasks--;
        reviewCount++;
        console.log(`  ✅ [AGENT] ${name} completed 1 task, reviewCount=${reviewCount}`);
      }
    } else if (name.startsWith('tester')) {
      if (reviewCount > 0) {
        reviewCount--;
        console.log(`  ✅ [AGENT] ${name} tested 1 task, reviewCount=${reviewCount}`);
      }
    } else if (name === 'pm') {
      console.log(`  ✅ [AGENT] pm: todo=${todoCount}, designed=${designedTasks}, review=${reviewCount}`);
    }
    
    return { success: true };
  }
};

// 测试配置
const config = {
  version: '3.1',
  workflow: {
    entry: 'test_reactive',
    nodes: {
      test_reactive: {
        type: 'reactive',
        description: '测试 reactive 轮询',
        pollInterval: 2000, // 2 秒轮询
        maxIdle: 5,
        agents: {
          tech_lead: {
            trigger: { condition: 'todoCount > 0 && designedTasks === 0' }
          },
          developer: {
            scalable: true,
            max: 2,
            trigger: { condition: 'designedTasks > 0' }
          },
          tester: {
            scalable: true,
            max: 2,
            trigger: { condition: 'reviewCount > 0' }
          },
          pm: {
            trigger: { on_event: ['tech_lead_complete', 'developer_complete', 'tester_complete'] }
          }
        },
        exit: {
          condition: 'todoCount === 0 && reviewCount === 0 && designedTasks === 0',
          next: 'test_standby'
        }
      },
      test_standby: {
        type: 'wait',
        description: '测试 standby 唤醒',
        trigger: 'new_task',
        pollInterval: 2000,
        maxWait: 20000,
        next: 'test_reactive'
      }
    }
  }
};

async function test() {
  console.log('=== 测试 Reactive 节点修复 ===\n');
  
  // 场景 1: 初始有任务
  console.log('\n[场景 1] 初始有 3 个任务');
  todoCount = 3;
  
  const engine = new WorkflowEngine(config, mockDaemon);
  
  // 启动 workflow（后台运行）
  const workflowPromise = engine.execute();
  
  // 等待 5 秒后添加新任务（测试轮询）
  setTimeout(() => {
    console.log('\n[场景 2] 5 秒后添加 2 个新任务（测试轮询触发）');
    todoCount += 2;
  }, 5000);
  
  // 等待 workflow 完成
  await workflowPromise;
  
  console.log('\n✅ 测试完成！');
  console.log('验证点：');
  console.log('1. reactive 节点通过轮询检测到新任务');
  console.log('2. standby 节点通过轮询被唤醒');
}

test().catch(e => {
  console.error('❌ 测试失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
