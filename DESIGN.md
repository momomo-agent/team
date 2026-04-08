# Team Engine v4 设计 — Workflow-First

## 核心转变

v3: agent-based — agent 有行为契约，workflow 编排 agent
v4: workflow-based — step 有状态契约，agent/脚本只是 step 的执行器

## 第一性原理

系统在做什么？

```
世界状态 → step 前置条件匹配 → 执行（agent | 脚本 | 函数）→ 世界状态变化 → ...
```

agent 不是主语。**step 是主语。**

step 说："当世界是这样时，做这件事，做完后世界应该变成那样。"
至于怎么做——派 LLM agent、跑 shell 脚本、调 API——都是执行细节。

## Step 定义

```json
{
  "id": "run-tests",
  "description": "对 review 状态的 task 跑测试",
  
  "when": "reviewCount > 0 || testingCount > 0",
  
  "execute": {
    "type": "agent",
    "agent": "tester",
    "parallel": 2
  },
  
  "demand": "reviewCount + testingCount",
  
  "post": {
    "tasks_in": "testing",
    "must_become": ["done", "blocked"],
    "evidence": "test-result.md",
    "on_fail_signal": { "contains": "fail", "not_contains": "0 fail", "status": "blocked" },
    "on_no_evidence": "review",
    "on_empty_evidence": "review"
  }
}
```

也可以是脚本：

```json
{
  "id": "lint-check",
  "description": "跑 lint 检查",
  
  "when": "reviewCount > 0",
  
  "execute": {
    "type": "shell",
    "command": "npm run lint",
    "cwd": "{{projectDir}}"
  },
  
  "post": {
    "on_exit_0": { "set_context": { "lintPassed": true } },
    "on_exit_nonzero": { "set_context": { "lintPassed": false } }
  }
}
```

### execute 类型

| type | 说明 | 参数 |
|------|------|------|
| `agent` | LLM agent | agent, parallel? |
| `shell` | Shell 命令 | command, cwd? |
| `function` | JS 函数（自定义节点用） | fn |
| `noop` | 什么都不做（纯 branch 节点） | — |

### post: 状态保证

post 不是 agent 的属性，是 **step 对世界状态的承诺**。

同一个 agent 在不同 step 里可以有不同 post：
- "run-tests" step 里 tester 的 post: testing → done/blocked
- "milestone-qg" step 里 tester 的 post: 可能不涉及 task 状态，只写 report

harness 只看 step 的 post 定义来做兜底，完全不知道 agent 是什么角色。

## Workflow 节点

节点包含 steps。节点之间的跳转靠 `next`（支持条件分支）。

```json
{
  "work_loop": {
    "type": "loop",
    "steps": [
      {
        "id": "pm-dispatch",
        "execute": { "type": "agent", "agent": "pm" }
      },
      {
        "id": "write-dbb",
        "when": "milestoneNeedsDBB > 0",
        "execute": { "type": "agent", "agent": "qa_lead" }
      },
      {
        "id": "write-design",
        "when": "todoWithoutDesign > 0",
        "execute": { "type": "agent", "agent": "tech_lead", "parallel": 3 },
        "demand": "todoWithoutDesign"
      },
      {
        "id": "run-tests",
        "when": "reviewCount > 0 || testingCount > 0",
        "execute": { "type": "agent", "agent": "tester", "parallel": 2 },
        "demand": "reviewCount + testingCount",
        "post": {
          "tasks_in": "testing",
          "must_become": ["done", "blocked"],
          "evidence": "test-result.md",
          "on_fail_signal": { "contains": "fail", "not_contains": "0 fail", "status": "blocked" },
          "on_no_evidence": "review",
          "on_empty_evidence": "review"
        }
      },
      {
        "id": "implement",
        "when": "designedTasks > 0",
        "execute": { "type": "agent", "agent": "developer", "parallel": 1 },
        "demand": "designedTasks",
        "post": {
          "tasks_in": "inProgress",
          "must_become": ["review"],
          "on_no_evidence": "review"
        }
      }
    ],
    "exit": {
      "condition": "todoCount == 0 && designedTasks == 0 && reviewCount == 0 && inProgressCount == 0 && testingCount == 0 && blockedCount == 0",
      "next": { "if": "doneCount > 0", "then": "milestone_qg", "else": "standby" }
    }
  }
}
```

注意：
- `when` = 原来的 trigger（step 级前置条件）
- `demand` = 表达式，决定并行几个实例
- `execute` = 执行方式（agent/shell/function）
- `post` = 状态保证（harness 兜底用）
- `parallel` 在 execute 里，因为它描述的是"这种执行方式最多几个并发"

## Engine 实现

engine 是纯状态机。它做五件事：
1. **buildContext** — 读项目状态，构建 context 变量
2. **evaluateCondition** — 评估表达式
3. **executeStep** — 根据 step.execute.type 派发执行
4. **enforcePost** — 执行完后检查 step.post 的状态保证
5. **resolveNext** — 跳转到下一个节点

```js
class WorkflowEngine {
  
  async executeStep(step, ctx) {
    // 1. 前置条件
    if (step.when && !this.evaluate(step.when, ctx)) {
      this.log('skip', step.id, step.when);
      return;
    }
    
    // 2. 执行
    const exec = step.execute || { type: 'noop' };
    
    switch (exec.type) {
      case 'agent':
        await this.executeAgent(exec, step, ctx);
        break;
      case 'shell':
        await this.executeShell(exec, step, ctx);
        break;
      case 'function':
        await exec.fn(ctx);
        break;
      case 'noop':
        break;
    }
    
    // 3. 后置保证
    if (step.post) {
      this.enforcePost(step.post);
    }
  }
  
  async executeAgent(exec, step, ctx) {
    const parallel = exec.parallel || 1;
    
    if (parallel > 1 && step.demand) {
      const demand = this.evaluate(step.demand, ctx);
      const count = Math.min(demand, parallel);
      // 并行/串行逻辑...
    } else {
      await this.daemon.runAgent(exec.agent);
    }
  }
  
  enforcePost(post) {
    if (!post.tasks_in) return;
    
    const orphaned = this.findTasksByStatus(post.tasks_in);
    for (const task of orphaned) {
      // 通用的 evidence → status 逻辑
      // 完全基于 post 配置，零硬编码
    }
  }
}
```

## 不变量

1. engine.js 里零 agent name — 不知道 tester/developer/pm 是什么
2. engine.js 里零 task status name — 不知道 testing/review/done 是什么
3. 新增执行类型 → 加一个 case 到 executeStep
4. 新增 agent → 只改 JSON
5. 新增脚本 step → 只改 JSON
6. step 的 post 是 step 的属性，不是 agent 的属性
7. 同一个 agent 在不同 step 里可以有不同 post

## 从 v3 到 v4 的差异

| 概念 | v3 | v4 |
|------|----|----|
| 主体 | agent | step |
| demand | engine 硬编码 | step.demand 表达式 |
| 并行度 | step.scalable + step.maxParallel | execute.parallel |
| 状态兜底 | daemon.fixOrphanedTaskStatus（按 agent name） | engine.enforcePost（按 step.post 配置） |
| 执行方式 | 只有 agent | agent / shell / function / noop |
| postcondition 归属 | agent 的属性 | step 的属性 |
| 新增 agent | 改 JS + JSON | 只改 JSON |

## 文件变化

- `workflow-engine-v3.js` → `workflow-engine.js`（重写）
- `daemon.js` — 删除 fixOrphanedTaskStatus，enforcePost 在 engine 层
- `configs/dev-team-v3.1.json` → `configs/dev-team.json`（step-based）
- `configs/nodes/*.json` — step 格式更新
- `DESIGN-V4.md` — 本文件
