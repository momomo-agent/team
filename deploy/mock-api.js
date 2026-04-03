// Mock API for static deployment
const mockConfig = {
  "version": "3.0",
  "name": "dev-team",
  "dashboard": {
    "left": [
      {"id": "vision", "title": "愿景", "type": "doc", "path": "VISION.md", "showInUI": true},
      {"id": "prd", "title": "产品需求", "type": "doc", "path": "PRD.md", "showInUI": true},
      {"id": "dbb", "title": "预期验收", "type": "doc", "path": "EXPECTED_DBB.md", "showInUI": true},
      {"id": "arch", "title": "技术架构", "type": "doc", "path": "ARCHITECTURE.md", "showInUI": true}
    ],
    "right": [
      {"id": "pipeline", "title": "Pipeline", "type": "view", "component": "PipelineView"},
      {"id": "kanban", "title": "Kanban", "type": "view", "component": "KanbanView"},
      {"id": "milestones", "title": "Milestones", "type": "view", "component": "MilestonesView"}
    ]
  }
};

const mockDocs = {
  vision: { content: "# DevTeam Dashboard\n\nAI 开发团队协作工具", match: 0 },
  prd: { content: "# 产品需求\n\nDemo 版本", match: 0 },
  dbb: { content: "# 预期验收\n\nDemo 版本", match: 0 },
  arch: { content: "# 技术架构\n\nDemo 版本", match: 0 }
};

const mockData = {
  status: { running: false, busy: false },
  milestones: { milestones: [] },
  kanban: { todo: [], inProgress: [], review: [], done: [] },
  pipeline: { stages: [] },
  agents: {},
  gaps: {}
};

// Override fetch for static deployment
const originalFetch = window.fetch;
window.fetch = function(url, options) {
  if (url === '/api/config') {
    return Promise.resolve({ json: () => Promise.resolve(mockConfig) });
  }
  if (url.startsWith('/doc/')) {
    const docId = url.replace('/doc/', '');
    return Promise.resolve({ json: () => Promise.resolve(mockDocs[docId] || {}) });
  }
  if (url === '/status') return Promise.resolve({ json: () => Promise.resolve(mockData.status) });
  if (url === '/milestones') return Promise.resolve({ json: () => Promise.resolve(mockData.milestones) });
  if (url === '/kanban') return Promise.resolve({ json: () => Promise.resolve(mockData.kanban) });
  if (url === '/pipeline') return Promise.resolve({ json: () => Promise.resolve(mockData.pipeline) });
  if (url === '/agents') return Promise.resolve({ json: () => Promise.resolve(mockData.agents) });
  if (url === '/gaps') return Promise.resolve({ json: () => Promise.resolve(mockData.gaps) });
  return originalFetch(url, options);
};
