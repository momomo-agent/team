/**
 * work_loop 节点 - JS 自定义版本
 * 展示复杂逻辑如何用 JS 实现
 */

module.exports = {
  type: 'loop',
  description: '工作循环',
  
  async do(ctx) {
    const agents = [];
    
    // 调试日志
    ctx.log(`[DEBUG] todoCount=${ctx.todoCount}, designedTasks=${ctx.designedTasks}, reviewCount=${ctx.reviewCount}, maxDevs=${ctx.maxDevs}`);
    
    // Tech Lead（只在有 todo 且没设计方案时才启动）
    if (ctx.todoCount > 0) {
      agents.push('tech_lead');
    }
    
    // Developer-N (scalable，需要有设计方案才启动)
    if (ctx.designedTasks > 0) {
      const count = Math.min(ctx.designedTasks, ctx.maxDevs);
      for (let i = 1; i <= count; i++) {
        agents.push(`developer-${i}`);
      }
    }
    
    // Tester-N (scalable，需要有 review 状态的任务才启动)
    if (ctx.reviewCount > 0) {
      const count = Math.min(Math.ceil(ctx.reviewCount / 2), 2);
      for (let i = 1; i <= count; i++) {
        agents.push(`tester-${i}`);
      }
    }
    
    // 没有任何 agent 需要启动 → 不做无用功
    if (agents.length === 0) {
      ctx.log('No agents to run, skipping iteration');
      return;
    }
    
    // 并行执行
    ctx.log(`Running ${agents.length} agents in parallel`);
    await ctx.runAgents(agents, true);
    
    // PM 再分配
    await ctx.runAgent('pm');
  },
  
  exit(ctx) {
    const kanban = ctx.kanban();
    const inProgress = (kanban.inProgress || []).length;
    const testing = (kanban.testing || []).length;
    const blocked = (kanban.blocked || []).length; // 修复 2: 增加 blocked 任务检查
    
    // 如果还有正在进行的工作，继续循环
    if (ctx.todoCount > 0 || ctx.reviewCount > 0 || inProgress > 0 || testing > 0 || blocked > 0) {
      return null; // 继续循环
    }
    
    // 所有任务都完成了（done），进入质量门禁
    if (ctx.doneCount > 0) {
      return 'quality_gate';
    }
    
    // 没有任何任务，进入待机
    return 'standby';
  }
};
