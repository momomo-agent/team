/**
 * MockRuntime — in-memory runtime for testing engine
 */

const RuntimeInterface = require('./runtime-interface');

class MockRuntime extends RuntimeInterface {
  constructor() {
    super();
    this.projectDir = '/tmp/mock-project';
    this._contextOverrides = {};

    // In-memory storage
    this._groups = { groups: [] };
    this._kanban = { todo: [], inProgress: [], review: [], testing: [], done: [], blocked: [] };
    this._tasks = {};       // { taskDir: { status, title, ... } }
    this._taskFiles = {};   // { 'taskDir/filename': 'content' }
    this._crs = {};         // { 'cr-123.json': { id, status, ... } }
    this._gaps = {};        // { 'vision': { match: 50 } }
    this._files = new Set(); // relative paths that "exist"
    this._functions = {};   // registered functions

    // Call log for assertions
    this.calls = [];

    // Configurable behavior
    this.agentResults = {};  // { agentType: true/false }
    this.defaultAgentResult = true;
  }

  _record(method, args) {
    this.calls.push({ method, args: [...args], time: Date.now() });
  }

  getCallsTo(method) {
    return this.calls.filter(c => c.method === method);
  }

  // ─── Core: Agent Execution ───

  async runAgent(agentType) {
    this._record('runAgent', arguments);
    const result = this.agentResults[agentType] ?? this.defaultAgentResult;
    if (typeof result === 'function') return result(agentType);
    return result;
  }

  // ─── Core: Data Queries ───

  getGroups() {
    this._record('getGroups', arguments);
    return this._groups;
  }

  getKanban() {
    this._record('getKanban', arguments);
    return this._kanban;
  }

  getActiveGroup() {
    return (this._groups.groups || []).find(g =>
      g.status === 'active' || g.status === 'ready-for-work' || g.status === 'in-progress'
    ) || null;
  }

  isGroupComplete() {
    this._record('isGroupComplete', arguments);
    const group = this.getActiveGroup();
    if (!group || !group.tasks || group.tasks.length === 0) return false;
    const doneSet = new Set(this._kanban.done || []);
    return group.tasks.every(id => doneSet.has(id));
  }

  // ─── Core: Task & CR Data Access ───

  readTask(taskDir) {
    this._record('readTask', arguments);
    return this._tasks[taskDir] || null;
  }

  updateTaskFields(taskDir, updates) {
    this._record('updateTaskFields', arguments);
    if (!this._tasks[taskDir]) return null;
    Object.assign(this._tasks[taskDir], updates);
    return this._tasks[taskDir];
  }

  listTaskDirs() {
    this._record('listTaskDirs', arguments);
    return Object.keys(this._tasks);
  }

  taskFileExists(taskDir, filename) {
    this._record('taskFileExists', arguments);
    return this._taskFiles.hasOwnProperty(taskDir + '/' + filename);
  }

  readTaskFile(taskDir, filename) {
    this._record('readTaskFile', arguments);
    return this._taskFiles[taskDir + '/' + filename] || null;
  }

  listCRFiles() {
    this._record('listCRFiles', arguments);
    return Object.keys(this._crs);
  }

  readCRFile(filename) {
    this._record('readCRFile', arguments);
    return this._crs[filename] || null;
  }

  updateCRFile(filename, updates) {
    this._record('updateCRFile', arguments);
    if (!this._crs[filename]) return null;
    Object.assign(this._crs[filename], updates);
    return this._crs[filename];
  }

  readGap(name) {
    this._record('readGap', arguments);
    return this._gaps[name] || null;
  }

  fileExists(relativePath) {
    this._record('fileExists', arguments);
    return this._files.has(relativePath);
  }

  // ─── Core: Functions ───

  executeFunction(fnName, args) {
    this._record('executeFunction', arguments);
    const fn = this._functions[fnName];
    if (fn) return fn(args);
  }

  // ─── Core: Logging ───

  log(event, agent, details) {
    this._record('log', arguments);
    // Silent in tests. Uncomment to debug:
    // console.log(`[MOCK] [${event}] ${agent || ''} ${details || ''}`);
  }

  // ─── Core: Events ───

  _eventHandlers = {};

  on(event, handler) {
    this._record('on', arguments);
    if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
    this._eventHandlers[event].push(handler);
  }

  off(event, handler) {
    this._record('off', arguments);
    if (!this._eventHandlers[event]) return;
    this._eventHandlers[event] = this._eventHandlers[event].filter(h => h !== handler);
  }

  emit(event, data) {
    const handlers = this._eventHandlers[event] || [];
    handlers.forEach(h => { try { h(data); } catch {} });
  }

  // ─── Test Helpers ───

  addTask(id, task) {
    this._tasks[id] = { id, status: 'todo', title: id, ...task };
  }

  addGroup(group) {
    this._groups.groups.push(group);
  }

  addGap(name, data) {
    this._gaps[name] = data;
  }

  addFile(path) {
    this._files.add(path);
  }

  registerFunction(name, fn) {
    this._functions[name] = fn;
  }

  reset() {
    this.calls = [];
    this._groups = { groups: [] };
    this._kanban = { todo: [], inProgress: [], review: [], testing: [], done: [], blocked: [] };
    this._tasks = {};
    this._taskFiles = {};
    this._crs = {};
    this._gaps = {};
    this._files = new Set();
    this._functions = {};
    this._eventHandlers = {};
    this._contextOverrides = {};
  }
}

module.exports = MockRuntime;
