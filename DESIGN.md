# DevTeam 系统设计文档

## 核心理念

**自上而下约束，自下而上反馈。**

每一层的产出必须符合上层预期。下层不能修改上层，只能提交变更请求（CR）由上层决策。

## 分层架构

```
┌─────────────────────────────────────────────────┐
│  L0  VISION（愿景）                              │  🔒 只有 kenefe + Momo 能改
│  产品为什么存在、要解决什么问题、终态是什么          │  Agent 只读
├─────────────────────────────────────────────────┤
│  L1  PRD + Expected DBB（产品方案 + 预期验收）     │  📝 架构师/PM 写
│  功能列表、用户故事                                 │  Momo 可评价调整
│  全局 DBB: 核心流程和体验守护（不是事无巨细）         │
├─────────────────────────────────────────────────┤
│  L2  ARCHITECTURE（技术架构）                     │  📝 架构师写
│  模块划分、接口契约、技术栈、依赖关系                │  Momo 可评价调整
├─────────────────────────────────────────────────┤
│  L3  MILESTONES（里程碑）                         │  📋 PM 管理
│  每个里程碑尽量可发布（基建版本例外）                │  需符合 L0-L2
│  里程碑 DBB: 完整且全的验收标准                     │
│  包含：overview + DBB + 技术方案 + Tasks            │
├─────────────────────────────────────────────────┤
│  L4  EXECUTION（执行）                            │  💻 开发 + 测试
│  编码、测试、交付                                  │  需符合 L3 的方案和 DBB
└─────────────────────────────────────────────────┘
```

## 修改权限矩阵

| 层级 | kenefe | Momo | 架构师 | PM | Tech Lead | 开发/测试 |
|------|--------|------|--------|-----|-----------|----------|
| L0 Vision | ✅ 写 | ✅ 写 | ❌ | ❌ | ❌ | ❌ |
| L1 PRD/DBB | ✅ 写 | 💬 评价调整 | ✅ 写 | ✅ 写 | 📤 提CR | ❌ |
| L2 Architecture | ✅ 写 | 💬 评价调整 | ✅ 写 | 📤 提CR | 📤 提CR | ❌ |
| L3 Milestones | ✅ 写 | 💬 评价调整 | 📤 提CR | ✅ 写 | ✅ 写 | ❌ |
| L4 Execution | ✅ | ✅ | ❌ | 📋 分配 | ✅ 方案 | ✅ 写 |

## 文件目录结构

```
project/
├── VISION.md                         # L0 愿景（只读）
├── PRD.md                            # L1 产品方案
├── EXPECTED_DBB.md                   # L1 全局预期验收标准
├── ARCHITECTURE.md                   # L2 技术架构
│
├── .team/
│   ├── config.json                   # 项目配置（名称、Agent 数量等）
│   ├── kanban.json                   # 全局看板状态
│   ├── agent-status.json             # Agent 实时运行状态
│   ├── daemon.pid                    # 守护进程 PID
│   │
│   ├── gaps/                         # 各层监控产出
│   │   ├── vision.json               # L0 匹配度 + gaps
│   │   ├── prd.json                  # L1 匹配度 + gaps
│   │   ├── architecture.json         # L2 匹配度 + gaps
│   │   └── milestones/               # L3 每个里程碑的 gaps
│   │       ├── m1.json
│   │       └── m2.json
│   │
│   ├── change-requests/              # 变更请求
│   │   ├── cr-001.json               # { from, to, reason, proposed_change, status }
│   │   └── cr-002.json
│   │
│   ├── milestones/                   # 里程碑详情
│   │   ├── milestones.json           # 里程碑列表 + 状态
│   │   ├── m1/
│   │   │   ├── overview.md           # 里程碑目标和范围
│   │   │   ├── dbb.md               # 本里程碑 DBB（验收标准）
│   │   │   ├── design.md            # 本里程碑技术方案
│   │   │   └── review.md            # 完成后评审结果
│   │   │       ├── vision-check.md   # vs 愿景检查
│   │   │       ├── prd-check.md      # vs PRD/DBB 检查
│   │   │       └── arch-check.md     # vs 架构检查
│   │   └── m2/ ...
│   │
│   └── tasks/                        # 任务详情
│       ├── task-xxx/
│       │   ├── task.json             # 元数据（优先级、状态、依赖、所属里程碑）
│       │   ├── design.md            # 任务级技术方案（Tech Lead 产出）
│       │   ├── progress.md          # 开发过程记录
│       │   ├── test-result.md       # 测试结果
│       │   └── artifacts/           # 产出物
│       └── ...
```

## 里程碑完成检查（三重验证）

每个里程碑完成时，必须跑三个检查，全部通过才算真正完成：

```
里程碑完成
    │
    ├── ✅ 架构检查 → arch-check.md
    │   "代码结构是否符合 ARCHITECTURE.md？"
    │   输出：match% + 具体不符合的模块/接口
    │
    ├── ✅ PRD/DBB 检查 → prd-check.md
    │   "功能是否符合 PRD.md + EXPECTED_DBB.md？"
    │   输出：match% + 缺失的功能/验收项
    │
    └── ✅ 愿景检查 → vision-check.md
        "整体方向是否符合 VISION.md？"
        输出：match% + 偏离的方向

三个检查的 gaps 汇总 → 下一个里程碑的输入
```

## Agent 角色定义

| Agent | 层级 | 职责 | 输入 | 输出 |
|-------|------|------|------|------|
| architect | L2 | 设计技术架构 | VISION, PRD | ARCHITECTURE.md |
| pm | L3 | 里程碑规划、任务分配 | ARCH, gaps | milestones.json, kanban.json |
| tech_lead | L3-L4 | 里程碑 DBB + 技术方案 + 任务方案 | ARCH, milestone | dbb.md, design.md |
| developer-N | L4 | 编码实现 | task/design.md | 代码 |
| tester-N | L4 | 测试验证 | milestone/dbb.md + task/design.md | test-result.md |
| vision_monitor | L0 | 愿景匹配度 | VISION, 代码 | gaps/vision.json, vision-check.md |
| prd_monitor | L1 | PRD匹配度 | PRD/DBB, 代码 | gaps/prd.json, prd-check.md |
| arch_monitor | L2 | 架构匹配度 | ARCH, 代码 | gaps/architecture.json, arch-check.md |

## 并行策略

### 工作循环内（每轮）

```
全并行:
  Tech Lead (出未设计任务的方案)
  Developer-1..N (做已有方案的任务，无方案则不启动)
  Tester-1..N (验已完成的任务)
→ 全部完成 → PM 再分配 → 继续循环
```

### 里程碑检查（完成时）

```
四重检查全并行:
  vision_monitor (vs 愿景)
  prd_monitor (vs PRD)
  dbb_monitor (vs 全局 DBB)
  arch_monitor (vs 架构)
→ 全部完成 → gaps 汇总 → PM 规划下一个
```

### 串行约束

```
VISION → PRD + DBB → ARCHITECTURE → Milestones (项目启动，一次性)
里程碑内: overview → dbb → design → tasks (每个里程碑开始时)
```

## Daemon 事件模型

```
项目启动:
  if no ARCHITECTURE.md → 架构师(串行)
  if no milestones → PM 创建里程碑(串行)
  → 进入工作循环

工作循环:
  tech_lead + developer-N + tester-N (全并行)
  → 全部完成 → PM 再分配
  → 有工作 → 继续循环
  → 无工作 → 等待

里程碑完成:
  三重检查全并行 (vision + prd + arch)
  → gaps 汇总 → review/ 存档
  → PM 规划下一个里程碑
  → 进入工作循环

变更请求:
  Agent 写 .team/change-requests/cr-xxx.json
  → 通知 Momo → Momo 评价
  → kenefe 决策（L0）或对应层级处理

兜底:
  10 分钟无活动 → 检查一次状态

错误保护:
  单 Agent 失败 → 标记 error，不影响其他
  API 超时 → 标记 timeout，下轮重试
  进程异常 → 捕获不退出
```

## CLI 命令设计

```bash
# 项目管理
team init <dir>                   # 初始化项目（创建完整目录结构）
team status                       # 总览（各层匹配度 + 里程碑 + Agent）

# 文档（分级权限由 prompt 控制）
team vision show                  # 查看愿景
team prd show                     # 查看 PRD
team arch show                    # 查看架构

# 里程碑
team milestone list               # 所有里程碑 + 状态
team milestone show <id>          # 详情（DBB + 方案 + 任务 + 检查结果）
team milestone create <name>      # 创建里程碑

# 任务
team task list [--milestone <id>] [--status <status>]
team task create <title> <desc> [--milestone <id>]
team task update <id> <json>
team task show <id>               # 详情（方案 + 进度 + 测试结果）

# Agent
team start [--devs N]             # 启动 daemon
team stop                         # 停止 daemon
team agents                       # Agent 实时状态

# 监控
team gaps [--level L0|L1|L2|L3]   # 查看 gaps
team check <milestone-id>         # 手动触发三重检查

# 变更请求
team cr list                      # 查看 CR
team cr show <id>                 # CR 详情
team cr approve <id>              # 批准
team cr reject <id>               # 拒绝

# Web
team web [--port 3000]            # 启动 Dashboard
```
