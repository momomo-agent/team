# DevTeam v3.1 架构审查报告

## 审查标准：一次做对

不考虑向后兼容，只考虑：
1. **架构是否正确** - 事件驱动 + 状态机 + 轮询看护
2. **实现是否完整** - 所有事件源都发送事件，所有监听者都正确监听
3. **代码是否优雅** - 没有冗余、没有 workaround、没有 hack
4. **逻辑是否严密** - 没有遗漏的边缘 case

---

## 发现的问题

### 1. ❌ 事件源不完整 - task-manager 不发送事件

**位置**: `lib/task-manager.js`

**问题**:
- `updateKanban()` 修改 kanban 后没有发送 `kanban_updated` 事件
- `createCR()` / `resolveCR()` 没有发送 `cr_changed` 事件
- task-manager 是独立的类，没有 daemon 引用，无法发送事件

**影响**:
- PM agent 更新 kanban 后，reactive 节点无法感知
- CR 创建/解决后，workflow 无法响应
- 只能靠轮询，事件驱动失效

**根因**: 架构设计问题 - task-manager 和 daemon 解耦，但事件需要耦合

### 2. ⚠️ 轮询看护逻辑不完整

**位置**: `agents/workflow-engine-v3.js:executeReactive()`

**问题**:
```javascript
const watchdogInterval = setInterval(() => {
  // 注释说"检查超时"，但实际没有检查任何超时
  if (runningAgents.size === 0) {
    evaluateTriggers(); // 这和 5 秒轮询重复了
  }
}, 60000);
```

**影响**:
- watchdog 没有实际作用
- 60 秒间隔太长，不如 5 秒轮询
- 代码冗余

### 3. ⚠️ 事件监听器清理问题

**位置**: `agents/workflow-engine-v3.js:executeReactive()`

**问题**:
```javascript
const evaluateTriggers = () => { ... };
this.daemon.on('kanban_updated', evaluateTriggers);
// ...
this.daemon.off('kanban_updated', evaluateTriggers);
```

**问题**: `evaluateTriggers` 是箭头函数，每次都是新引用，`off()` 可能无法正确移除

**建议**: 用 `bind()` 或保存引用

### 4. ⚠️ 条件评估器有安全风险

**位置**: `agents/workflow-engine-v3.js:evaluateCondition()`

**问题**:
```javascript
const fn = new Function(...Object.keys(ctx), 'Math', `return ${condition}`);
```

**风险**: 直接执行用户输入的字符串，有注入风险

**建议**: 
- 用白名单限制可用变量和函数
- 或用 AST 解析器（如 esprima）

### 5. ⚠️ reactive 节点退出逻辑不清晰

**位置**: `agents/workflow-engine-v3.js:executeReactive()`

**问题**:
```javascript
while (!exitRequested) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // 如果没有运行中的 agent 且退出条件满足，退出
  if (runningAgents.size === 0 && this.shouldExitReactive(node, this.buildContext())) {
    exitRequested = true;
  }
}
```

**问题**: 
- 退出条件检查了两次（evaluateTriggers 里也检查）
- 逻辑分散，不清晰

### 6. ⚠️ wait 节点没有事件监听

**位置**: `agents/workflow-engine-v3.js:executeWait()`

**当前**: 纯轮询模式

**问题**: 
- 如果配置了 `trigger: "new_task"`，应该监听 `kanban_updated` 事件
- 纯轮询有延迟，不够实时

### 7. ⚠️ daemon 的 getInProgressCount / getTestingCount 可能不存在

**位置**: `agents/workflow-engine-v3.js:buildContext()`

```javascript
inProgressCount: this.daemon.getInProgressCount ? this.daemon.getInProgressCount() : 0,
testingCount: this.daemon.getTestingCount ? this.daemon.getTestingCount() : 0,
```

**问题**: 用了三元运算符防御，说明这些方法可能不存在

**建议**: 要么实现这些方法，要么删除这些字段

### 8. ⚠️ runningAgents 用 Set 存储，但检查时用 startsWith

**位置**: `agents/workflow-engine-v3.js:executeReactive()`

```javascript
const alreadyRunning = runningAgents.has(agentName) || 
                       Array.from(runningAgents).some(a => a.startsWith(agentName + '-'));
```

**问题**: 
- Set 转 Array 再 some，性能差
- 应该用 Map 存储 `agentName -> count`

### 9. ⚠️ 文件锁可能导致死锁

**位置**: `lib/task-manager.js:saveKanban()`

```javascript
let release;
try {
  release = lockfile.lockSync(this.kanbanPath, { retries: 5, stale: 10000 });
  fs.writeFileSync(this.kanbanPath, JSON.stringify(kanban, null, 2));
} finally {
  if (release) release();
}
```

**问题**: 
- 如果 writeFileSync 抛异常，锁会在 finally 里释放（这是对的）
- 但如果进程崩溃，锁会 stale（10 秒后自动释放）
- 10 秒太长，应该改为 5 秒

### 10. ❌ daemon-v2.js 和 daemon.js 重复

**问题**: 
- 两个文件功能几乎一样
- daemon-v2.js 没有 EventEmitter
- daemon.js 有 EventEmitter
- 应该只保留一个

---

## 修复方案

### 方案 A: task-manager 接受 daemon 引用（推荐）

```javascript
class TaskManager {
  constructor(projectDir, daemon = null) {
    this.projectDir = projectDir;
    this.daemon = daemon; // 新增
  }
  
  updateKanban(taskId, newStatus) {
    // ... 原有逻辑
    if (this.daemon) {
      this.daemon.emit('kanban_updated', { taskId, newStatus });
    }
  }
}
```

**优点**: 
- 简单直接
- 不破坏现有 CLI 用法（daemon 参数可选）
- 事件驱动完整

### 方案 B: task-manager 自己实现 EventEmitter

```javascript
class TaskManager extends EventEmitter {
  updateKanban(taskId, newStatus) {
    // ... 原有逻辑
    this.emit('kanban_updated', { taskId, newStatus });
  }
}

// daemon 里
this.taskManager = new TaskManager(projectDir);
this.taskManager.on('kanban_updated', (data) => {
  this.emit('kanban_updated', data); // 转发
});
```

**缺点**: 
- 更复杂
- 需要转发事件

### 方案 C: 全局 EventBus

**缺点**: 
- 引入全局状态
- 测试困难

---

## 修复优先级

### P0 - 必须修复（影响核心功能）

1. ✅ task-manager 发送事件（方案 A）
2. ✅ 删除 daemon-v2.js，统一用 daemon.js
3. ✅ 修复 watchdog 逻辑（要么实现真正的超时检测，要么删除）

### P1 - 应该修复（影响代码质量）

4. ✅ 修复事件监听器清理
5. ✅ 简化 reactive 退出逻辑
6. ✅ wait 节点增加事件监听
7. ✅ 实现 getInProgressCount / getTestingCount 或删除

### P2 - 可以优化（不影响功能）

8. ⚠️ 条件评估器安全加固（暂不修复，内部工具可接受）
9. ⚠️ runningAgents 用 Map（暂不修复，性能影响小）
10. ⚠️ 文件锁 stale 时间调整（暂不修复，10 秒可接受）

---

## 下一步

1. 实现修复
2. 运行测试验证
3. 提交 git commit
