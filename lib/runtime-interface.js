/**
 * RuntimeInterface — engine 依赖的最小接口
 *
 * 任何实现了这个接口的对象都可以作为 engine 的 runtime。
 * 本地执行用 Runtime，远程/沙箱/mock 可以各自实现。
 *
 * @interface
 */
class RuntimeInterface {
  constructor() {
    if (new.target === RuntimeInterface) {
      throw new Error('RuntimeInterface is abstract — implement it');
    }

    /** @type {string} */
    this.projectDir = '';

    /** @type {object|null} context overrides for workflow expressions */
    this._contextOverrides = null;
  }

  // ─── Core: Agent Execution ───

  /** Run an agent by type name. Returns Promise<boolean> (success). */
  async runAgent(agentType) { throw new Error('not implemented'); }

  // ─── Core: Data Queries ───

  /** Get all groups (milestones/sprints/phases). Returns { groups: [...] } */
  getGroups() { throw new Error('not implemented'); }

  /** Get kanban board. Returns { todo: [], inProgress: [], ... } */
  getKanban() { throw new Error('not implemented'); }

  /** Is the current active group complete? Returns boolean. */
  isGroupComplete() { throw new Error('not implemented'); }

  // ─── Core: Functions ───

  /** Execute a registered function by name. */
  executeFunction(fnName, args) { throw new Error('not implemented'); }

  // ─── Core: Logging ───

  /** Log a workflow event. */
  log(event, agent, details) { throw new Error('not implemented'); }

  // ─── Core: Events ───

  /** Subscribe to an event. */
  on(event, handler) { throw new Error('not implemented'); }

  /** Unsubscribe from an event. */
  off(event, handler) { throw new Error('not implemented'); }
}

module.exports = RuntimeInterface;
