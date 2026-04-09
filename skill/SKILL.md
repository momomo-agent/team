# Team CLI Skill

## What is Team?

Team CLI 是一个 AI 多项目开发团队系统。给项目配上 goal + workflow，daemon 自动循环执行，直到目标达成。

**核心概念**：
- **Workflow** — 定义角色和流程（PM → developer → tester）
- **Goal** — 目标条件（Vision ≥90% + PRD ≥90%）
- **Daemon** — 后台循环执行，自动调度 agents
- **Multi-team** — 一个项目可以有多个 team（dev-team, ui-design, ops）

## Installation

Team CLI 位于 `~/LOCAL/momo-agent/tools/team/`

全局命令：`team`（已 symlink 到 /usr/local/bin/）

## Quick Start

### 1. 初始化项目

```bash
cd <project-dir>

# 开发团队（完整流程：PM + architect + tech_lead + dev + tester）
team init . --config dev-team

# 轻量开发（简化流程：tech_lead + dev + tester）
team init . --config dev-lite

# UI 设计迭代（设计 → 开发 → 审核 → 循环）
team init . --config design-iteration
```

### 2. 启动 daemon

```bash
team start
# 或指定并发数
team start --devs 3
```

### 3. 查看状态

```bash
# 单项目状态
team status

# 所有项目一览
team overview
```

### 4. 停止

```bash
# 优雅停止
team stop

# 强制杀掉（daemon 卡住时）
team kill
```

## Multi-team Support

一个项目可以有多个 team，每个 team 独立运行：

```
.team/
├── dev-team/           # 开发团队
│   ├── config.json
│   ├── daemon.pid
│   └── tasks/
├── ui-design/          # UI 设计团队
│   ├── config.json
│   ├── daemon.pid
│   └── iterations/
└── ops/                # 运维团队
    ├── config.json
    └── ...
```

**CLI**:
```bash
team start dev-team
team start ui-design
team overview           # 显示所有 team
team status dev-team
```

## Available Workflows

### dev-team (完整开发流程)

**角色**：PM + architect + tech_lead + developer + tester + monitor

**流程**：
1. startup → 初始化
2. monitor → 评估 Vision/PRD gap
3. pm_decide → PM 创建 milestone + tasks
4. work_loop → tech_lead 设计 → developer 实现 → tester 验证
5. milestone_qg → 质量门禁（DBB 验证 + git sync）
6. goal_check → 评估目标达成
7. complete → 达成目标自动停止

**适用**：大项目，需要架构设计和质量门禁

### dev-lite (轻量开发流程)

**角色**：tech_lead + developer + tester

**流程**：
1. startup → 初始化
2. work_loop → tech_lead 创建 task + 写设计 → developer 实现 → tester 验证
3. check-prd → 评估 PRD match
4. complete → PRD ≥90% 自动停止

**适用**：小项目，快速迭代

### design-iteration (UI 设计迭代)

**角色**：designer + developer + reviewer

**流程**：
1. startup → 初始化
2. design-loop → designer 提设计方案 → developer 实现 → reviewer 评审
3. 循环条件：gapScore < 20 或 iteration ≥ 5 时停止
4. complete → 设计达标自动停止

**适用**：UI/UX 优化，视觉迭代

## Custom Workflows

创建自定义 workflow：

```bash
mkdir -p .team/my-workflow/{nodes,prompts}
```

**config.json**:
```json
{
  "name": "my-workflow",
  "entry": "startup",
  "agents": {
    "role1": {
      "role": "Role Name",
      "model": "claude-sonnet-4",
      "prompt": "prompts/role1.md"
    }
  }
}
```

**nodes/startup.json**:
```json
{
  "type": "entry",
  "next": "work-loop"
}
```

**nodes/work-loop.json**:
```json
{
  "type": "sequence",
  "steps": [
    { "id": "step1", "execute": { "type": "agent", "agent": "role1" } }
  ],
  "next": {
    "if": "goalReached",
    "then": "complete",
    "else": "work-loop"
  }
}
```

## Conditional Branching

Workflow 支持条件分支和循环：

```json
{
  "next": {
    "if": "gapScore < 20",
    "then": "complete",
    "else": {
      "if": "iteration >= 5",
      "then": "complete",
      "else": "design-loop"
    }
  }
}
```

**可用变量**：
- `iteration` — 当前迭代次数
- `gapScore` — gap 评分
- `todoCount` — todo 任务数
- `reviewCount` — review 任务数
- `blockedCount` — blocked 任务数
- `prdMatch` — PRD 匹配度

## Dashboard

实时监控：`http://192.168.31.211:3000`

显示：
- 所有项目状态（🏁 已完成 / ⏸️ 已停止 / ✅ 运行中）
- 当前 goal + match + critical gaps
- Tasks 分布（todo/review/blocked/done）
- Agent 活动日志

## Watchdog

自动重启崩溃的 daemon：

```bash
# 查看 watchdog 状态
ps aux | grep watchdog

# 手动启动（team start 会自动启动）
node ~/LOCAL/momo-agent/tools/team/scripts/watchdog.js --interval=300
```

## Tips

1. **目标要明确** — goal 写清楚终止条件（Vision ≥90% + PRD ≥90%）
2. **workflow 要简单** — 角色不要太多，流程不要太复杂
3. **用 dev-lite 快速验证** — 大项目前先用 lite 跑通流程
4. **多 team 隔离** — dev-team 和 ui-design 分开，互不干扰
5. **定期 overview** — `team overview` 看所有项目健康度

## Troubleshooting

**Daemon 卡住**：
```bash
team kill
team start
```

**找不到 config.json**：
```bash
# 检查是否初始化
ls .team/config.json
# 或检查 multi-team
ls .team/*/config.json
```

**Agent 报错**：
```bash
# 查看日志
tail -f .team/daemon.log
tail -f .team/agents/*.log
```

## Repository

- GitHub: `momomo-agent/team` (public)
- Local: `~/LOCAL/momo-agent/tools/team/`
- Dashboard: `http://192.168.31.211:3000`
