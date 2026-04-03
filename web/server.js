#!/usr/bin/env node
/**
 * DevTeam Web Dashboard Server
 *
 * API Endpoints:
 *   /status          - Project config, daemon status, agent count, match percentages
 *   /gaps            - Vision/PRD/Architecture gaps with match% and gap lists
 *   /milestones      - Full milestone list with task counts and completion %
 *   /kanban          - Kanban board (optional ?milestone=<id> filter)
 *   /vision          - Vision doc content
 *   /architecture    - Architecture doc + diagram
 *   /agents          - Agent status
 *   /daemon/status   - Daemon running status
 *   /daemon/start    - Start daemon (POST)
 *   /daemon/stop     - Stop daemon (POST)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const projectDir = process.argv[2] || process.cwd();
const PORT = parseInt(process.argv[3]) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function readJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

function readFile(filepath) {
  try { return fs.readFileSync(filepath, 'utf8'); }
  catch { return null; }
}

function parseMarkdown(filePath) {
  const content = readFile(filePath) || '';
  const matchLine = content.match(/当前匹配度:\s*(\d+)%/);
  return { content, match: matchLine ? parseInt(matchLine[1]) : 0 };
}

function parseArchitecture(content) {
  const mermaidMatch = content.match(/```mermaid\n([\s\S]*?)\n```/);
  const diagram = mermaidMatch ? mermaidMatch[1] : '';
  
  // Pre-render mermaid to SVG if available
  if (diagram) {
    const svgCache = path.join(projectDir, '.team/arch-diagram.svg');
    const mmdCache = path.join(projectDir, '.team/arch-diagram.mmd');
    
    // Only re-render if mermaid source changed
    let needsRender = true;
    try {
      if (fs.existsSync(mmdCache) && fs.existsSync(svgCache)) {
        const cached = fs.readFileSync(mmdCache, 'utf8');
        if (cached === diagram) needsRender = false;
      }
    } catch {}
    
    if (needsRender) {
      try {
        fs.writeFileSync(mmdCache, diagram);
        const { execSync } = require('child_process');
        execSync(`mmdc -i "${mmdCache}" -o "${svgCache}" -b transparent --quiet`, { timeout: 15000 });
      } catch {}
    }
    
    try {
      if (fs.existsSync(svgCache)) {
        const svg = fs.readFileSync(svgCache, 'utf8');
        return { diagram, diagramSvg: svg };
      }
    } catch {}
  }
  
  return { diagram, diagramSvg: '' };
}

function getModuleCompletion() {
  const archGaps = readJSON(path.join(projectDir, '.team/gaps/architecture.json'));
  
  // Priority: use gaps data (arch_monitor output) as authoritative source
  if (archGaps) {
    const modules = [];
    
    // archGaps.modules (array format)
    if (archGaps.modules && Array.isArray(archGaps.modules)) {
      for (const mod of archGaps.modules) {
        modules.push({
          name: mod.name || mod.module,
          status: mod.status || 'partial',
          coverage: mod.coverage || (mod.status === 'implemented' ? 100 : mod.status === 'missing' ? 0 : 50)
        });
      }
    }
    
    // archGaps.details (object format from monitor)
    if (archGaps.details && typeof archGaps.details === 'object') {
      for (const [key, detail] of Object.entries(archGaps.details)) {
        const status = detail.status || 'partial';
        const cov = status === 'implemented' ? 100 : status === 'missing' ? 0 : 50;
        // Avoid duplicates
        if (!modules.find(m => m.name === key)) {
          modules.push({ name: key, status, coverage: cov });
        }
      }
    }
    
    if (modules.length > 0) return modules;
  }
  
  // Fallback: parse ## headings from ARCHITECTURE.md
  const archContent = readFile(path.join(projectDir, 'ARCHITECTURE.md')) || '';
  const modules = [];
  const moduleRegex = /^##\s+(.+)/gm;
  let match;
  while ((match = moduleRegex.exec(archContent)) !== null) {
    const name = match[1].trim();
    if (name && !name.match(/^(overview|introduction|目录|概述)/i)) {
      modules.push({ name, status: 'partial', coverage: 0 });
    }
  }
  return modules;
}

function getTaskDetails(ids) {
  return ids.map(id => {
    const p = path.join(projectDir, '.team/tasks', id, 'task.json');
    const task = readJSON(p);
    return task || { id, title: id };
  });
}

function getMilestones() {
  const data = readJSON(path.join(projectDir, '.team/milestones/milestones.json'));
  if (!data || !data.milestones) return [];

  const kanban = readJSON(path.join(projectDir, '.team/kanban.json')) || {};
  const doneSet = new Set(kanban.done || []);

  return data.milestones.map(ms => {
    const tasks = (ms.tasks || []).map(tid => {
      const task = readJSON(path.join(projectDir, '.team/tasks', tid, 'task.json'));
      return task || { id: tid, title: tid, status: 'unknown' };
    });
    const doneCount = ms.tasks.filter(tid => doneSet.has(tid)).length;
    return {
      ...ms,
      taskCount: ms.tasks.length,
      doneCount,
      progress: ms.tasks.length > 0 ? Math.round((doneCount / ms.tasks.length) * 100) : 0,
      taskDetails: tasks
    };
  });
}

function getAllGaps() {
  const monitorDir = path.join(projectDir, '.team/monitor');
  const config = readJSON(path.join(projectDir, '.team/config.json')) || {};
  const result = {};

  // Read monitor outputs from config
  if (config.docs && config.docs.items) {
    config.docs.items.forEach(function(doc) {
      if (doc.monitor && doc.monitor.output) {
        const data = readJSON(path.join(projectDir, doc.monitor.output));
        if (data) {
          // Normalize: support both 'match' and 'score'
          if (data.match == null && data.score != null) data.match = data.score;
          result[doc.id] = data;
        }
      }
    });
  }

  return result;
}

function isDaemonRunning() {
  const pidPath = path.join(projectDir, '.team/daemon.pid');
  if (!fs.existsSync(pidPath)) return false;
  const pid = readFile(pidPath).trim();
  try {
    process.kill(parseInt(pid), 0);
    return true;
  } catch {
    try { fs.unlinkSync(pidPath); } catch {}
    return false;
  }
}

function getAgents() {
  return readJSON(path.join(projectDir, '.team/agent-status.json')) || {};
}

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

  const sendJSON = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // --- API Routes ---

  if (pathname === '/api/config') {
    const configPath = path.join(projectDir, '.team/config.json');
    const config = readJSON(configPath) || {};
    sendJSON(config);
  }
  else if (pathname === '/status') {
    const config = readJSON(path.join(projectDir, '.team/config.json')) || {};
    const running = isDaemonRunning();
    const agents = getAgents();
    const activeCount = Object.values(agents).filter(a => a.status === 'running').length;
    const gaps = getAllGaps();
    
    // Extract project name from VISION.md title
    const visionPath = path.join(projectDir, 'VISION.md');
    let projectName = config.name || 'DevTeam';
    try {
      const visionContent = fs.readFileSync(visionPath, 'utf8');
      const titleMatch = visionContent.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        projectName = titleMatch[1].replace(/^Vision:\s*/i, '').trim();
      }
    } catch {}
    
    sendJSON({
      project: { ...config, name: projectName },
      daemon: running,
      agentCount: Object.keys(agents).length,
      activeAgentCount: activeCount,
      match: {
        vision: gaps.vision ? gaps.vision.match : 0,
        prd: gaps.prd ? gaps.prd.match : 0,
        dbb: gaps.dbb ? gaps.dbb.match : 0,
        architecture: gaps.architecture ? gaps.architecture.match : 0
      }
    });
  }
  else if (pathname === '/gaps') {
    const gaps = getAllGaps();
    sendJSON(gaps);
  }
  else if (pathname === '/milestones') {
    sendJSON({ milestones: getMilestones() });
  }
  else if (pathname === '/kanban') {
    const milestoneFilter = parsed.query.milestone;
    const kanban = readJSON(path.join(projectDir, '.team/kanban.json')) || {
      todo: [], inProgress: [], blocked: [], review: [], testing: [], done: []
    };

    // If milestone filter, only include tasks belonging to that milestone
    let filteredKanban = kanban;
    if (milestoneFilter) {
      const msData = readJSON(path.join(projectDir, '.team/milestones/milestones.json'));
      const milestone = msData && msData.milestones
        ? msData.milestones.find(m => m.id === milestoneFilter)
        : null;
      if (milestone) {
        const taskSet = new Set(milestone.tasks || []);
        filteredKanban = {};
        for (const col of ['todo', 'inProgress', 'blocked', 'review', 'testing', 'done']) {
          filteredKanban[col] = (kanban[col] || []).filter(id => taskSet.has(id));
        }
      }
    }

    const total = (filteredKanban.todo || []).length + (filteredKanban.inProgress || []).length +
      (filteredKanban.blocked || []).length + (filteredKanban.review || []).length +
      (filteredKanban.testing || []).length + (filteredKanban.done || []).length;

    sendJSON({
      todo: getTaskDetails(filteredKanban.todo || []),
      inProgress: getTaskDetails(filteredKanban.inProgress || []),
      blocked: getTaskDetails(filteredKanban.blocked || []),
      review: getTaskDetails(filteredKanban.review || []),
      testing: getTaskDetails(filteredKanban.testing || []),
      done: getTaskDetails(filteredKanban.done || []),
      total,
      completion: total > 0 ? Math.round(((filteredKanban.done || []).length / total) * 100) : 0
    });
  }
  else if (pathname.startsWith('/file/')) {
    // v3.1: 按 path 直接获取文档
    const filePath = pathname.replace('/file/', '');
    const fullPath = path.join(projectDir, filePath);
    
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    
    const data = parseMarkdown(fullPath);
    sendJSON(data);
  }
  else if (pathname.startsWith('/doc/')) {
    const docId = pathname.replace('/doc/', '');
    const config = readJSON(path.join(projectDir, '.team/config.json')) || {};
    
    // 支持新配置：dashboard.left
    let doc = null;
    if (config.dashboard && config.dashboard.left) {
      doc = config.dashboard.left.find(function(d) { return d.id === docId; });
    }
    // 兼容旧配置：docs.items
    else if (config.docs && config.docs.items) {
      doc = config.docs.items.find(function(d) { return d.id === docId; });
    }
    
    if (!doc) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Doc not found' }));
      return;
    }
    
    // 新配置用 path，旧配置用 file
    const docFile = doc.path || doc.file;
    let docPath;
    
    // 新配置：path 是相对项目根目录
    if (doc.path) {
      docPath = path.join(projectDir, doc.path);
    }
    // 旧配置：file 是相对 docs.root
    else {
      const docRoot = config.docs && config.docs.root ? config.docs.root : '.team/docs';
      docPath = path.join(projectDir, docRoot, docFile);
    }
    
    const data = parseMarkdown(docPath);
    
    if (doc.monitor && doc.monitor.output) {
      const monitorData = readJSON(path.join(projectDir, doc.monitor.output));
      if (monitorData) {
        data.match = monitorData.match || monitorData.score || 0;
        data.gaps = monitorData.gaps || [];
      }
    }
    
    sendJSON(data);
  }
  else if (pathname === '/vision') {
    const data = parseMarkdown(path.join(projectDir, 'VISION.md'));
    const gaps = readJSON(path.join(projectDir, '.team/gaps/vision.json'));
    if (gaps) data.match = gaps.match;
    sendJSON(data);
  }
  else if (pathname === '/architecture') {
    const data = parseMarkdown(path.join(projectDir, 'ARCHITECTURE.md'));
    const arch = parseArchitecture(data.content);
    const gaps = readJSON(path.join(projectDir, '.team/gaps/architecture.json'));
    if (gaps && gaps.match == null && gaps.coverage != null) gaps.match = gaps.coverage;
    const modules = getModuleCompletion();
    sendJSON({ ...arch, content: data.content, match: gaps ? gaps.match : data.match, modules });
  }
  else if (pathname === '/prd') {
    const data = parseMarkdown(path.join(projectDir, 'PRD.md'));
    const gaps = readJSON(path.join(projectDir, '.team/gaps/prd.json'));
    if (gaps && gaps.match == null && gaps.coverage != null) gaps.match = gaps.coverage;
    if (gaps) data.match = gaps.match;
    sendJSON(data);
  }
  else if (pathname === '/dbb') {
    const data = parseMarkdown(path.join(projectDir, 'EXPECTED_DBB.md'));
    const gaps = readJSON(path.join(projectDir, '.team/gaps/dbb.json'));
    if (gaps && gaps.match == null && gaps.coverage != null) gaps.match = gaps.coverage;
    if (gaps) data.match = gaps.match;
    sendJSON(data);
  }
  else if (pathname === '/agents') {
    sendJSON(getAgents());
  }
  else if (pathname === '/change-requests') {
    // Task 1: GET /change-requests endpoint
    const crDir = path.join(projectDir, '.team/change-requests');
    const crs = [];
    if (fs.existsSync(crDir)) {
      try {
        const files = fs.readdirSync(crDir).filter(function(f) { return f.endsWith('.json'); });
        for (const f of files) {
          const cr = readJSON(path.join(crDir, f));
          if (cr) crs.push(cr);
        }
      } catch {}
    }
    sendJSON(crs);
  }
  else if (pathname === '/history') {
    // Task 7: GET /history endpoint
    const history = readJSON(path.join(projectDir, '.team/daemon-history.json')) || [];
    sendJSON(history);
  }
  else if (pathname === '/pipeline') {
    // Pipeline view: merge workflow stages + agent status + recent history
    const configPath = path.join(projectDir, '.team/config.json');
    const projectConfig = readJSON(configPath) || {};
    const defaultConfig = readJSON(path.join(__dirname, '../configs/default.json')) || {};
    const workflow = projectConfig.workflow || defaultConfig.workflow || {};
    const agents = getAgents();
    const history = readJSON(path.join(projectDir, '.team/daemon-history.json')) || [];

    // Build pipeline stages from workflow
    const stages = [
      { id: 'architecture', name: '架构设计', icon: '🏗️', agents: ['architect'], phase: 'startup' },
      { id: 'monitoring', name: '监控评估', icon: '📊', agents: ['vision_monitor', 'prd_monitor', 'dbb_monitor', 'arch_monitor'], phase: 'startup' },
      { id: 'planning', name: '任务规划', icon: '📋', agents: ['pm'], phase: 'startup' },
      { id: 'design', name: '技术方案', icon: '🔧', agents: ['tech_lead'], phase: 'loop' },
      { id: 'development', name: '开发实现', icon: '💻', agents: ['developer'], phase: 'loop', scalable: true },
      { id: 'testing', name: '测试验证', icon: '🧪', agents: ['tester'], phase: 'loop', scalable: true },
      { id: 'review', name: '评审分配', icon: '🔄', agents: ['pm'], phase: 'loop-end' }
    ];

    // Enrich each stage with live agent data + recent history
    const recentHistory = history.slice(-100);
    const enriched = stages.map(stage => {
      // Find all agents matching this stage (including scaled like developer-1, developer-2)
      const stageAgents = [];
      for (const [name, info] of Object.entries(agents)) {
        const baseName = name.replace(/-\d+$/, '');
        if (stage.agents.includes(baseName) || stage.agents.includes(name)) {
          stageAgents.push({ name, ...info });
        }
      }
      // Recent events for this stage
      const stageEvents = recentHistory.filter(e => {
        if (!e.agent) return false;
        const base = e.agent.replace(/-\d+$/, '');
        return stage.agents.includes(base) || stage.agents.includes(e.agent);
      }).slice(-10);

      return { ...stage, liveAgents: stageAgents, recentEvents: stageEvents };
    });

    sendJSON({ stages: enriched });
  }
  else if (pathname === '/daemon/status') {
    sendJSON({ running: isDaemonRunning() });
  }
  else if (pathname === '/daemon/start' && req.method === 'POST') {
    const { spawn } = require('child_process');
    const daemonPath = path.join(__dirname, '../agents/daemon.js');
    const logPath = path.join(projectDir, '.team/daemon.log');
    const out = fs.openSync(logPath, 'a');
    const err = fs.openSync(logPath, 'a');

    const daemon = spawn('node', [daemonPath, projectDir], {
      detached: true,
      stdio: ['ignore', out, err]
    });
    daemon.unref();
    fs.writeFileSync(path.join(projectDir, '.team/daemon.pid'), daemon.pid.toString());
    sendJSON({ success: true, pid: daemon.pid });
  }
  else if (pathname === '/daemon/stop' && req.method === 'POST') {
    const pidPath = path.join(projectDir, '.team/daemon.pid');
    if (fs.existsSync(pidPath)) {
      const pid = readFile(pidPath).trim();
      try {
        process.kill(parseInt(pid), 'SIGTERM');
        fs.unlinkSync(pidPath);
      } catch {}
    }
    sendJSON({ success: true });
  }
  else {
    // Static files
    const filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(PUBLIC_DIR, filePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      const contentType = CONTENT_TYPES[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(fullPath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, () => {
  console.log(`DevTeam Dashboard: http://localhost:${PORT}`);
  console.log(`Project: ${projectDir}`);
});
