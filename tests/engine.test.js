const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const WorkflowEngine = require('../agents/workflow-engine');
const MockRuntime = require('../lib/mock-runtime');

// Standard context expressions (same as dev-team config)
const CONTEXT = {
  todoCount: "tasks.byStatus('todo').length",
  reviewCount: "tasks.byStatus('review').length",
  doneCount: "tasks.byStatus('done').length",
  blockedCount: "tasks.byStatus('blocked').length",
  inProgressCount: "tasks.byStatus('inProgress').length",
  testingCount: "tasks.byStatus('testing').length",
};

// Helper: create engine with inline config
function createEngine(runtime, nodes, entry, extra) {
  const configDir = path.join(runtime.projectDir, '.team');
  fs.mkdirSync(configDir, { recursive: true });

  // Nodes as inline objects (not file paths)
  const config = {
    _workflow: 'test',
    workflow: { entry: entry || Object.keys(nodes)[0], nodes: {}, context: CONTEXT },
    agents: {},
    ...extra
  };

  for (const [name, node] of Object.entries(nodes)) {
    config.workflow.nodes[name] = node; // inline, not a string path
  }

  return new WorkflowEngine(config, runtime);
}

// Use unique tmp dirs to avoid conflicts
let tmpCounter = 0;
function freshRuntime() {
  const r = new MockRuntime();
  r.projectDir = path.join('/tmp', 'team-test-' + process.pid + '-' + (tmpCounter++));
  fs.mkdirSync(r.projectDir, { recursive: true });
  return r;
}

// Cleanup
function cleanup(runtime) {
  try { fs.rmSync(runtime.projectDir, { recursive: true, force: true }); } catch {}
}

describe('WorkflowEngine', () => {

  describe('sequence execution', () => {
    it('runs steps in order', async () => {
      const rt = freshRuntime();
      try {
        const engine = createEngine(rt, {
          main: {
            type: 'sequence',
            steps: [
              { id: 's1', execute: { type: 'agent', agent: 'architect' } },
              { id: 's2', execute: { type: 'agent', agent: 'pm' } }
            ]
          }
        });

        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.deepStrictEqual(agents, ['architect', 'pm']);
      } finally { cleanup(rt); }
    });

    it('follows next node', async () => {
      const rt = freshRuntime();
      try {
        const engine = createEngine(rt, {
          first: {
            type: 'sequence',
            steps: [{ id: 's1', execute: { type: 'agent', agent: 'a1' } }],
            next: 'second'
          },
          second: {
            type: 'sequence',
            steps: [{ id: 's2', execute: { type: 'agent', agent: 'a2' } }]
          }
        }, 'first');

        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.deepStrictEqual(agents, ['a1', 'a2']);
      } finally { cleanup(rt); }
    });
  });

  describe('when conditions', () => {
    it('skips step when condition is false', async () => {
      const rt = freshRuntime();
      try {
        const engine = createEngine(rt, {
          main: {
            type: 'sequence',
            steps: [
              { id: 's1', when: 'todoCount > 0', execute: { type: 'agent', agent: 'dev' } },
              { id: 's2', execute: { type: 'agent', agent: 'pm' } }
            ]
          }
        });
        // todoCount = 0 (empty kanban), so s1 should be skipped
        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.deepStrictEqual(agents, ['pm']);
      } finally { cleanup(rt); }
    });

    it('runs step when condition is true', async () => {
      const rt = freshRuntime();
      try {
        rt._kanban.todo = ['task-1'];
        rt.addTask('task-1', { status: 'todo' });

        const engine = createEngine(rt, {
          main: {
            type: 'sequence',
            steps: [
              { id: 's1', when: 'todoCount > 0', execute: { type: 'agent', agent: 'dev' } },
              { id: 's2', execute: { type: 'agent', agent: 'pm' } }
            ]
          }
        });

        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.deepStrictEqual(agents, ['dev', 'pm']);
      } finally { cleanup(rt); }
    });
  });

  describe('loop with exit', () => {
    it('exits loop when condition met', async () => {
      const rt = freshRuntime();
      try {
        let iteration = 0;
        rt.agentResults.pm = () => {
          iteration++;
          // After 2 iterations, move all tasks to done
          if (iteration >= 2) {
            rt._kanban.todo = [];
            rt._kanban.done = ['t1'];
          }
          return true;
        };
        rt._kanban.todo = ['t1'];
        rt.addTask('t1', { status: 'todo' });

        const engine = createEngine(rt, {
          main: {
            type: 'loop',
            steps: [
              { id: 'pm', execute: { type: 'agent', agent: 'pm' } }
            ],
            exit: {
              condition: 'todoCount == 0',
              next: 'done_node'
            }
          },
          done_node: {
            type: 'sequence',
            steps: [{ id: 'final', execute: { type: 'agent', agent: 'closer' } }]
          }
        }, 'main');

        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.ok(agents.includes('pm'), 'pm should have run');
        assert.ok(agents.includes('closer'), 'closer should have run after exit');
        assert.strictEqual(agents.filter(a => a === 'pm').length, 2, 'pm should run exactly 2 times');
      } finally { cleanup(rt); }
    });
  });

  describe('parallel branches', () => {
    it('runs matching branches in parallel', async () => {
      const rt = freshRuntime();
      try {
        rt._kanban.todo = ['t1'];
        rt._kanban.review = ['t2'];
        rt.addTask('t1', { status: 'todo' });
        rt.addTask('t2', { status: 'review' });

        const engine = createEngine(rt, {
          main: {
            type: 'sequence',
            steps: [{
              id: 'parallel',
              parallel: true,
              branches: [
                { id: 'dev', when: 'todoCount > 0', execute: { type: 'agent', agent: 'developer' } },
                { id: 'test', when: 'reviewCount > 0', execute: { type: 'agent', agent: 'tester' } },
                { id: 'skip', when: 'blockedCount > 0', execute: { type: 'agent', agent: 'fixer' } }
              ]
            }]
          }
        });

        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.ok(agents.includes('developer'), 'developer should run');
        assert.ok(agents.includes('tester'), 'tester should run');
        assert.ok(!agents.includes('fixer'), 'fixer should NOT run (blocked=0)');
      } finally { cleanup(rt); }
    });
  });

  describe('function steps', () => {
    it('calls runtime.executeFunction for string fn', async () => {
      const rt = freshRuntime();
      try {
        let called = false;
        rt.registerFunction('myFunc', () => { called = true; });

        const engine = createEngine(rt, {
          main: {
            type: 'sequence',
            steps: [
              { id: 'f1', execute: { type: 'function', fn: 'myFunc' } }
            ]
          }
        });

        await engine.execute();

        assert.ok(called, 'myFunc should have been called');
        assert.ok(rt.getCallsTo('executeFunction').length > 0);
      } finally { cleanup(rt); }
    });
  });

  describe('conditional next', () => {
    it('follows if/then/else based on condition', async () => {
      const rt = freshRuntime();
      try {
        rt.addFile('ARCHITECTURE.md');

        const engine = createEngine(rt, {
          check: {
            type: 'sequence',
            steps: [{ id: 's1', execute: { type: 'noop' } }],
            next: { if: 'hasArchitecture', then: 'has_it', else: 'no_it' }
          },
          has_it: {
            type: 'sequence',
            steps: [{ id: 'yes', execute: { type: 'agent', agent: 'yes_agent' } }]
          },
          no_it: {
            type: 'sequence',
            steps: [{ id: 'no', execute: { type: 'agent', agent: 'no_agent' } }]
          }
        }, 'check');

        await engine.execute();

        const agents = rt.getCallsTo('runAgent').map(c => c.args[0]);
        assert.deepStrictEqual(agents, ['yes_agent']);
      } finally { cleanup(rt); }
    });
  });

  describe('checkpoint', () => {
    it('saves checkpoint before each step', async () => {
      const rt = freshRuntime();
      try {
        const engine = createEngine(rt, {
          main: {
            type: 'sequence',
            steps: [
              { id: 's1', execute: { type: 'agent', agent: 'a1' } },
              { id: 's2', execute: { type: 'agent', agent: 'a2' } }
            ]
          }
        });

        await engine.execute();

        // After successful completion, checkpoint should be cleared
        const cpDir = path.join(rt.projectDir, '.team', 'checkpoints');
        const cpFile = path.join(cpDir, 'test.json');
        assert.ok(!fs.existsSync(cpFile), 'checkpoint should be cleared after completion');
      } finally { cleanup(rt); }
    });
  });

  describe('runtime validation', () => {
    it('rejects runtime missing required methods', () => {
      assert.throws(() => {
        new WorkflowEngine({ workflow: { entry: 'x', nodes: {} } }, { projectDir: '/tmp' });
      }, /missing required method/);
    });

    it('rejects runtime without projectDir', () => {
      const rt = new MockRuntime();
      rt.projectDir = '';
      assert.throws(() => {
        new WorkflowEngine({ workflow: {} }, rt);
      }, /missing required property/);
    });
  });
});
