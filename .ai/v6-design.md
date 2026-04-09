# Team v6.0 — Composable Teams

## 核心变更

**一切都是 team，team 可以调用 team。**

### 概念统一

- 去掉 `workflow` 概念，统一为 `team`
- `execute.type: "workflow"` → `execute.type: "team"`
- 顶层 team = 有 daemon 驱动的 team
- sub-team = 被父 team 的 step 调用的 team

### execute types (v6)

- `agent` — 跑一个 LLM agent
- `shell` — 跑一个命令
- `team` — 调用另一个 team（替代原来的 `workflow`）
- `noop` — 空操作
- `function` — 内部函数（保留兼容）
- `group` — 遍历 milestones（保留兼容）

### Sub-team 调用

```json
{
  "id": "test-phase",
  "execute": {
    "type": "team",
    "config": "tester-team",
    "input": {
      "taskId": "{{currentTaskId}}"
    }
  }
}
```

sub-team 有自己的 config.json + nodes/，和顶层 team 结构完全一样。

### 目录结构

```
configs/
├── dev-team/              ← 顶层 team
│   ├── config.json
│   ├── nodes/
│   └── prompts/
├── developer-team/        ← sub-team
│   ├── config.json
│   └── nodes/
│       ├── startup.json
│       ├── read-spec.json
│       ├── implement.json
│       ├── self-verify.json
│       └── complete.json
├── tester-team/           ← sub-team
│   ├── config.json
│   └── nodes/
│       ├── startup.json
│       ├── compile-check.json
│       ├── unit-test.json
│       ├── integration-test.json
│       ├── e2e-test.json
│       └── complete.json
├── architect-team/        ← sub-team
│   ├── config.json
│   └── nodes/
├── design-iteration/      ← 顶层 team
├── dev-lite/              ← 顶层 team
└── ops-team/              ← 顶层 team (future)
```

## Sub-team 设计

### developer-team

```
startup → read-spec → implement → self-verify-build → self-verify-test → commit → complete
                         ↑                |                  |
                         └── 失败 (≤3次) ──┘                  │
                                          └── 失败 (≤3次) ────┘
```

**nodes:**
1. `startup` — 读 task.json + design.md + ARCHITECTURE.md + verify-errors/
2. `read-spec` — agent 读 spec，提取关键 API 和实现要求
3. `implement` — agent 写代码
4. `self-verify-build` — shell: `{{verify.build}}`，失败回 implement
5. `self-verify-test` — shell: `{{verify.test}}`，失败回 implement
6. `commit` — shell: git add + commit
7. `complete` — 更新 task status → review

### tester-team

```
startup → compile-check → unit-test → integration-test → e2e-test → report → complete
              |                |              |               |
              └── 失败 → blocked (写错误日志)
```

**nodes:**
1. `startup` — 读 task.json + design.md + dbb.md
2. `compile-check` — shell: `{{verify.build}}`
3. `unit-test` — shell: `{{verify.test}}`
4. `integration-test` — agent: 写集成测试 + 跑
5. `e2e-test` — agent: 用 agent-control 跑端到端测试（如果配置了 verify.e2e）
6. `report` — agent: 写 test-result.md + test-coverage.json
7. `complete` — 更新 task status → done

### architect-team

```
startup → read-deps → design → validate-refs → complete
              ↑                      |
              └── 失败 (API 不存在) ──┘
```

**nodes:**
1. `startup` — 读 VISION.md + PRD.md + gaps/
2. `read-deps` — shell: grep 依赖源码提取 API 签名
3. `design` — agent: 写 ARCHITECTURE.md
4. `validate-refs` — shell: 检查引用的 API 是否真实存在
5. `complete` — done

## 引擎改动

### workflow-engine.js

1. `executeStepWorkflow` → `executeStepTeam`（重命名）
2. switch case: `workflow` → `team`（保留 `workflow` 做兼容别名）
3. sub-team 执行时继承父 team 的 runtime（projectDir、task manager 等）
4. sub-team 的 verify 从项目级 `.team/verify.json` 读取

### 兼容性

- `type: "workflow"` 继续工作（内部映射到 team）
- 现有 config.json 的 `workflow` 字段保留
- 渐进迁移：新 team 用 `type: "team"`，旧的不强制改

## 实现步骤

1. 引擎：`executeStepWorkflow` → `executeStepTeam`，加 `workflow` 别名
2. 创建 developer-team config + nodes
3. 创建 tester-team config + nodes
4. 创建 architect-team config + nodes
5. 更新 dev-team work-loop：用 `type: "team"` 调用 sub-teams
6. 更新 dev-lite work-loop：同上
7. 测试：跑 engine.test.js + 实际项目验证
8. 更新 skill 文档
