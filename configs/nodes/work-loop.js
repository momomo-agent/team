/**
 * work_loop 节点 - JS 自定义版本
 * 展示复杂逻辑如何用 JS 实现
 */

module.exports = {
  type: 'loop',
  description: '工作循环',
  
  async do(ctx) {
    const agents = [];
    
    // Tech Lead
    if (ctx.todoCount > 0) {
      agents.push('tech_lead');
    }
    
    // Developer-N (scalable)
    if (ctx.designedTasks > 0) {
      const count = Math.min(ctx.designedTasks, ctx.maxDevs);
      for (let i = 1; i <= count; i++) {
        agents.push(`developer-${i}`);
      }
    }
    
    // Tester-N (scalable)
    if (ctx.reviewCount > 0) {
      const count = Math.min(Math.ceil(ctx.reviewCount / 2), 2);
      for (let i = 1; i <= count; i++) {
        agents.push(`tester-${i}`);
      }
    }
    
    // 并行执行
    if (agents.length > 0) {
      ctx.log(`Running ${agents.length} agents in parallel`);
      await ctx.runAgents(agents, true);
    }
    
    // PM 再分配
    await ctx.runAgent('pm');
  },
  
  exit(ctx) {
    if (ctx.isMilestoneComplete()) {
      return 'quality_gate';
    }
    if (ctx.todoCount === 0 && ctx.reviewCount === 0) {
      return 'standby';
    }
    // 继续循环：返回 null 或 undefined
    return null;
  }
};
