var daemonRunning = false;
var activeMilestoneId = null;
var selectedMilestoneId = null;
var activeTab = 'vision';
var activeRightTab = 'pipeline';
var activeMobileTab = 'pipeline';
var cachedMilestones = [];
var cachedGaps = {};
var expandedStages = {};
var teamConfig = null;
var dashboardTabs = [];

// --- Load Config and Initialize Tabs ---
fetch('/api/config').then(function(r) { return r.json(); }).then(function(config) {
  teamConfig = config;
  
  // 显示 workflow 名称
  if (config._workflow) {
    document.getElementById('workflow-name').textContent = 'Workflow: ' + config._workflow;
  } else if (config.name) {
    document.getElementById('workflow-name').textContent = config.name;
  } else if (config.workflow && config.workflow.name) {
    document.getElementById('workflow-name').textContent = config.workflow.name;
  } else if (config.workflow && config.workflow.entry) {
    document.getElementById('workflow-name').textContent = 'Workflow: ' + config.workflow.entry;
  } else {
    document.getElementById('workflow-name').textContent = 'Standard Workflow';
  }
  
  // v3.1: 多组件支持
  if (config.dashboard && config.dashboard.left && config.dashboard.left[0] && config.dashboard.left[0].components) {
    // 左侧 tabs
    var leftTabs = config.dashboard.left.map(function(tab, i) {
      return {
        id: 'tab-' + i,
        title: tab.title,
        components: tab.components
      };
    });
    initializeTabs(leftTabs);
    
    // 右侧 tabs
    if (config.dashboard.right) {
      dashboardTabs = config.dashboard.right.map(function(tab, i) {
        return {
          id: 'rtab-' + i,
          title: tab.title,
          components: tab.components
        };
      });
      initializeRightTabs(dashboardTabs);
      if (dashboardTabs.length > 0) {
        activeRightTab = dashboardTabs[0].id;
        activeMobileTab = dashboardTabs[0].id;
      }
    }
  }
  // v3.0: 兼容旧配置
  else if (config.dashboard && config.dashboard.left) {
    var leftTabs = config.dashboard.left.filter(function(t) { return t.showInUI !== false; });
    initializeTabs(leftTabs);
    
    if (config.dashboard.right) {
      dashboardTabs = config.dashboard.right;
      initializeRightTabs(dashboardTabs);
      if (dashboardTabs.length > 0) {
        activeRightTab = dashboardTabs[0].id;
        activeMobileTab = dashboardTabs[0].id;
      }
    }
  }
  // v2.0: 兼容更旧配置
  else if (config.docs && config.docs.items) {
    initializeTabs(config.docs.items.filter(function(d) { return d.showInUI; }));
  }
  
  // 配置加载完成后刷新数据
  refresh();
}).catch(function() {});

function initializeTabs(tabs) {
  var tabBar = document.getElementById('tab-bar');
  var paper = tabBar.nextElementSibling;
  tabBar.innerHTML = '';
  paper.innerHTML = '';
  
  tabs.forEach(function(tab, i) {
    var tabEl = document.createElement('div');
    tabEl.className = 'folder-tab' + (i === 0 ? ' active' : '');
    tabEl.dataset.tab = tab.id;
    tabEl.innerHTML = (tab.name || tab.title || tab.id) + ' <span class="tab-match" id="tab-match-' + tab.id + '">—</span>';
    tabBar.appendChild(tabEl);
    
    var pane = document.createElement('div');
    pane.className = 'tab-pane' + (i === 0 ? ' active' : '');
    pane.id = 'pane-' + tab.id;
    paper.appendChild(pane);
  });
  
  if (tabs.length > 0) activeTab = tabs[0].id;
}

function initializeRightTabs(tabs) {
  var tabBar = document.getElementById('right-tab-bar');
  var paper = tabBar.nextElementSibling;
  tabBar.innerHTML = '';
  paper.innerHTML = '';
  
  tabs.forEach(function(tab, i) {
    var rtab = document.createElement('div');
    rtab.className = 'right-tab' + (i === 0 ? ' active' : '');
    rtab.dataset.rtab = tab.id;
    rtab.textContent = tab.title;
    tabBar.appendChild(rtab);
    
    var pane = document.createElement('div');
    pane.className = 'right-pane' + (i === 0 ? ' active' : '');
    pane.id = 'rpane-' + tab.id;
    paper.appendChild(pane);
  });
}


// --- Left Tab Switching ---
document.getElementById('tab-bar').addEventListener('click', function(e) {
  var tab = e.target.closest('.folder-tab');
  if (!tab) return;
  var tabName = tab.dataset.tab;
  if (!tabName) return;
  activeTab = tabName;
  document.querySelectorAll('.folder-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
  tab.classList.add('active');
  var pane = document.getElementById('pane-' + tabName);
  if (pane) pane.classList.add('active');
});

// ====== LOGS VIEW ======
function renderLogs(events) {
  var el = document.getElementById('rpane-logs');
  if (!el) return;
  if (!events || events.length === 0) {
    el.innerHTML = '<div style="color:#888;font-size:11px;padding:8px;font-family:monospace;">No events yet.</div>';
    return;
  }
  var html = '';
  for (var i = events.length - 1; i >= 0; i--) {
    var ev = events[i];
    var type = ev.event || ev.type || '';
    var typeClass = type === 'error' ? 'error' : type === 'agent_complete' ? 'agent_complete' : type === 'agent_start' ? 'agent_start' : '';
    var time = ev.time ? formatTime(ev.time) : '';
    var agent = escapeHtml(ev.agent || ev.source || '—');
    var details = escapeHtml(ev.details || ev.message || type);
    html += '<div class="log-entry ' + typeClass + '">';
    html += '<span class="log-time">' + time + '</span>';
    html += '<span class="log-agent">' + agent + '</span>';
    html += '<span class="log-details">' + details + '</span>';
    html += '</div>';
  }
  el.innerHTML = html;
}

function refreshLogs() {
  if (activeRightTab !== 'logs') return;
  fetch('/events/recent?limit=200').then(function(r) { return r.json(); }).then(renderLogs).catch(function() {});
}

setInterval(refreshLogs, 10000);

// --- Right Tab Switching (with logs support) ---
document.getElementById('right-tab-bar').addEventListener('click', function(e) {
  var tab = e.target.closest('.right-tab');
  if (!tab) return;
  var tabName = tab.dataset.rtab;
  if (!tabName) return;
  activeRightTab = tabName;
  document.querySelectorAll('.right-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.right-pane').forEach(function(p) { p.classList.remove('active'); });
  tab.classList.add('active');
  var pane = document.getElementById('rpane-' + tabName);
  if (pane) pane.classList.add('active');
  if (tabName === 'logs') refreshLogs();
});

// --- Mobile Tab Switching ---
var mobileTabBar = document.getElementById('mobile-tab-bar');
if (mobileTabBar) {
  mobileTabBar.addEventListener('click', function(e) {
    var tab = e.target.closest('.mobile-tab');
    if (!tab) return;
    var tabName = tab.dataset.mtab;
    if (!tabName) return;
    activeMobileTab = tabName;
    document.querySelectorAll('.mobile-tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    syncMobilePane();
  });
}

function syncMobilePane() {
  var mp = document.getElementById('mobile-paper');
  if (!mp) return;
  
  var rightPanes = dashboardTabs.length > 0 
    ? dashboardTabs.map(function(t) { return t.id; })
    : ['pipeline', 'kanban', 'milestones'];
  var leftPanes = ['vision', 'prd', 'dbb', 'arch'];

  var src = null;
  if (rightPanes.indexOf(activeMobileTab) !== -1) {
    src = document.getElementById('rpane-' + activeMobileTab);
  } else if (leftPanes.indexOf(activeMobileTab) !== -1) {
    src = document.getElementById('pane-' + activeMobileTab);
  }
  
  // 直接复制 innerHTML（refresh 每 5 秒会重新同步）
  mp.innerHTML = src ? src.innerHTML : '';
}

// --- Data Loading ---
async function refresh() {
  try {
    // v3.1: 收集所有需要加载的数据
    var dataFetches = [];
    var leftTabs = [];
    var rightTabs = [];
    
    if (teamConfig && teamConfig.dashboard) {
      // 左侧 tabs
      if (teamConfig.dashboard.left) {
        if (teamConfig.dashboard.left[0] && teamConfig.dashboard.left[0].components) {
          // v3.1: 多组件
          leftTabs = teamConfig.dashboard.left;
        } else {
          // v3.0: 单组件（兼容）
          leftTabs = teamConfig.dashboard.left.filter(function(t) { return t.showInUI !== false; });
        }
      }
      
      // 右侧 tabs
      if (teamConfig.dashboard.right) {
        if (teamConfig.dashboard.right[0] && teamConfig.dashboard.right[0].components) {
          // v3.1: 多组件
          rightTabs = teamConfig.dashboard.right;
        } else {
          // v3.0: 单组件（兼容）
          rightTabs = teamConfig.dashboard.right;
        }
      }
    }
    // v2.0: 兼容更旧配置
    else if (teamConfig && teamConfig.docs && teamConfig.docs.items) {
      leftTabs = teamConfig.docs.items.filter(function(d) { return d.showInUI; });
    }

    // fallback: 右侧 tabs 默认值
    if (rightTabs.length === 0) {
      rightTabs = [
        { id: 'pipeline', name: 'Pipeline', component: 'PipelineView' },
        { id: 'kanban', name: 'Kanban', component: 'KanbanView' },
        { id: 'milestones', name: 'Milestones', component: 'MilestonesView' }
      ];
    }
    
    // 加载基础数据
    var results = await Promise.all([
      fetch('/status').then(function(r) { return r.json(); }),
      fetch('/gaps').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/milestones').then(function(r) { return r.json(); }).catch(function() { return { milestones: [] }; }),
      fetch('/agents').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/pipeline').then(function(r) { return r.json(); }).catch(function() { return { stages: [] }; })
    ]);

    var status = results[0];
    var gaps = results[1];
    var msData = results[2];
    var agents = results[3];
    var pipeline = results[4];

    var milestones = msData.milestones || [];
    cachedMilestones = milestones;
    cachedGaps = gaps;
    var activeMs = milestones.find(function(m) { return m.status === 'active'; });
    activeMilestoneId = activeMs ? activeMs.id : null;

    var kanbanMsId = selectedMilestoneId || activeMilestoneId;
    var kanbanUrl = kanbanMsId ? '/kanban?milestone=' + encodeURIComponent(kanbanMsId) : '/kanban';
    var kanban = await fetch(kanbanUrl).then(function(r) { return r.json(); }).catch(function() {
      return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [], total: 0, completion: 0 };
    });

    // Cache full kanban for client-side filtering
    window.cachedKanban = kanban;

    renderTopBar(status, agents);
    updateTabMatches(status, gaps);
    
    // 渲染左侧 tabs
    for (var i = 0; i < leftTabs.length; i++) {
      var tab = leftTabs[i];
      var tabId = tab.id || ('tab-' + i);
      var pane = document.getElementById('pane-' + tabId);
      if (!pane) continue;
      
      // v3.1: 多组件
      if (tab.components) {
        pane.innerHTML = '';
        for (var j = 0; j < tab.components.length; j++) {
          var comp = tab.components[j];
          await renderComponent(pane, comp, gaps);
        }
        
        // 更新 badge
        if (tab.badge) {
          var badgeData = await fetch('/file/' + tab.badge.source).then(function(r) { return r.json(); }).catch(function() { return {}; });
          var badgeValue = badgeData[tab.badge.field];
          if (badgeValue != null) {
            updateTabBadge(tabId, badgeValue);
          }
        }
      }
      // v3.0/v2.0: 单组件（兼容）
      else if (tab.path || tab.file) {
        var docPath = tab.path || tab.file;
        var docData = await fetch('/doc/' + tab.id).then(function(r) { return r.json(); }).catch(function() { return {}; });
        renderDoc(tabId, docData, gaps);
      }
    }
    
    // 渲染右侧 tabs
    for (var i = 0; i < rightTabs.length; i++) {
      var tab = rightTabs[i];
      var tabId = tab.id || ('rtab-' + i);
      var pane = document.getElementById('rpane-' + tabId);
      if (!pane) continue;
      
      // v3.1: 多组件
      if (tab.components) {
        pane.innerHTML = '';
        for (var j = 0; j < tab.components.length; j++) {
          var comp = tab.components[j];
          if (comp.component === 'PipelineView') {
            renderPipelineInPane(pane, pipeline);
          } else if (comp.component === 'KanbanView') {
            renderKanbanInPane(pane, kanban, milestones);
          } else if (comp.component === 'MilestonesView') {
            renderMilestonesInPane(pane, milestones);
          }
        }
      }
      // v3.0: 单组件（兼容）
      else {
        if (tab.component === 'PipelineView' || tabId === 'pipeline') {
          renderPipeline(pipeline);
        } else if (tab.component === 'KanbanView' || tabId === 'kanban') {
          renderKanban(kanban, milestones);
        } else if (tab.component === 'MilestonesView' || tabId === 'milestones') {
          renderMilestones(milestones);
        }
      }
    }

    // Sync mobile pane after all renders
    syncMobilePane();
  } catch (err) {
    console.error('Refresh error:', err);
  }
}

// 渲染单个组件到指定 pane
async function renderComponent(pane, comp, gaps) {
  if (comp.component === 'MarkdownView') {
    var docData = await fetch('/file/' + comp.path).then(function(r) { return r.json(); }).catch(function() { 
      return { content: '', match: 0 };
    });
    
    var container = document.createElement('div');
    container.className = 'markdown-view';
    
    // 添加 monitor 评估结果（如果有 gaps 数据）
    var html = '';
    if (gaps && comp.gapKey) {
      var gapData = gaps[comp.gapKey];
      if (gapData) {
        var match = gapData.match || gapData.coverage || 0;
        var gapsList = gapData.gaps || [];
        html += renderMatchDisplay(comp.label + ' Match', match);
        html += renderGapsList(gapsList);
      }
    }
    
    // 添加原文内容
    html += AgenticRender.render(docData.content || '');
    container.innerHTML = html;
    pane.appendChild(container);
  }
}

// --- Top Bar ---
function renderTopBar(status, agents) {
  var projectName = (status.project && status.project.name) || 'DevTeam';
  var running = status.daemon;

  document.getElementById('project-name').textContent = projectName;
  document.getElementById('page-title').textContent = projectName + ' — ' + (running ? 'Running' : 'Idle');

  var badge = document.getElementById('status-badge');
  badge.textContent = running ? 'RUNNING' : 'IDLE';
  badge.className = 'status-badge ' + (running ? 'running' : 'idle');

  daemonRunning = running;
  document.getElementById('toggle-daemon').textContent = running ? 'Stop' : 'Start';

  var color = running ? '%234ade80' : '%23888';
  document.getElementById('favicon').href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='" + color + "'/></svg>";

  var entries = Object.entries(agents);
  var activeCount = entries.filter(function(e) { return e[1].status === 'running'; }).length;
  var countEl = document.getElementById('agent-count');
  countEl.textContent = activeCount > 0 ? activeCount + ' agent' + (activeCount > 1 ? 's' : '') + ' active' : entries.length + ' agents';
}

// --- Tab match badges ---
function updateTabMatches(status, gaps) {
  var matchData = status.match || {};
  var tabs = { vision: matchData.vision, prd: matchData.prd, dbb: matchData.dbb, arch: matchData.architecture };

  Object.keys(tabs).forEach(function(key) {
    var val = tabs[key];
    var hasData = val != null;
    var display = hasData ? val + '%' : '—';
    var colorClass = !hasData ? '' : val > 80 ? 'green' : val > 50 ? 'yellow' : 'red';

    var el = document.getElementById('tab-match-' + key);
    if (el) { el.textContent = display; el.className = 'tab-match ' + colorClass; }

    var mel = document.getElementById('m-tab-match-' + key);
    if (mel) { mel.textContent = display; mel.className = 'tab-match ' + colorClass; }
  });
}

// v3.1: 更新单个 tab 的 badge
function updateTabBadge(tabId, value) {
  var val = Math.round(value);
  var colorClass = val > 80 ? 'green' : val > 50 ? 'yellow' : 'red';
  
  var el = document.getElementById('tab-match-' + tabId);
  if (el) {
    el.textContent = val + '%';
    el.className = 'tab-match ' + colorClass;
  }
}

// ====== PIPELINE VIEW ======
function renderPipeline(pipeline) {
  var el = document.getElementById('rpane-pipeline');
  var stages = pipeline.stages || [];

  if (stages.length === 0) {
    el.innerHTML = '<div style="color:#888;font-size:11px;padding:16px;">No pipeline data. Start the daemon to see the workflow.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < stages.length; i++) {
    var stage = stages[i];
    var hasActive = stage.liveAgents.some(function(a) { return a.status === 'running'; });
    var hasError = stage.liveAgents.some(function(a) { return a.status === 'error'; });
    var hasWaiting = stage.liveAgents.some(function(a) { return a.status === 'retrying'; });
    var stageClass = hasActive ? 'has-active' : hasError ? 'has-error' : '';
    var dotClass = hasActive ? 'running' : hasError ? 'error' : hasWaiting ? 'waiting' : 'idle';

    var isExpanded = expandedStages[stage.id] !== false; // default expanded

    html += '<div class="pipeline-stage ' + stageClass + '">';
    html += '<div class="stage-header" onclick="toggleStage(\'' + stage.id + '\')">';
    html += '<span class="stage-icon">' + (stage.icon || '⚙️') + '</span>';
    html += '<span class="stage-name">' + escapeHtml(stage.name) + '</span>';
    html += '<span class="stage-status-dot ' + dotClass + '"></span>';
    html += '</div>';

    if (isExpanded) {
      html += '<div class="stage-body">';

      if (stage.liveAgents.length === 0) {
        html += '<div class="stage-empty">等待进入此阶段</div>';
      } else {
        for (var j = 0; j < stage.liveAgents.length; j++) {
          var agent = stage.liveAgents[j];
          var aStatus = agent.status || 'idle';
          var aClass = aStatus === 'running' ? 'running' : aStatus === 'error' ? 'error' : aStatus === 'retrying' ? 'retrying' : '';

          html += '<div class="pipeline-agent ' + aClass + '">';
          html += '<span class="pa-dot ' + aStatus + '"></span>';
          html += '<span class="pa-name">' + escapeHtml(agent.name) + '</span>';

          if (agent.currentTask) {
            html += '<span class="pa-task">' + escapeHtml(agent.currentTask) + '</span>';
          }

          if (agent.lastRun) {
            html += '<span class="pa-time">' + formatTime(agent.lastRun) + '</span>';
          }

          html += '</div>';
        }
      }

      // Recent events
      if (stage.recentEvents && stage.recentEvents.length > 0) {
        html += '<div class="stage-events">';
        var events = stage.recentEvents.slice(-5);
        for (var k = 0; k < events.length; k++) {
          var ev = events[k];
          var evDotClass = ev.event || 'start';
          html += '<div class="stage-event">';
          html += '<span class="se-time">' + formatTime(ev.time) + '</span>';
          html += '<span class="se-dot ' + evDotClass + '"></span>';
          html += '<span>' + escapeHtml((ev.agent || '') + ' ' + (ev.details || '')) + '</span>';
          html += '</div>';
        }
        html += '</div>';
      }

      html += '</div>'; // stage-body
    }

    html += '</div>'; // pipeline-stage

    // Connector between stages
    if (i < stages.length - 1) {
      html += '<div class="pipeline-connector"></div>';
    }
  }

  el.innerHTML = html;
}

function toggleStage(stageId) {
  expandedStages[stageId] = expandedStages[stageId] === false ? true : false;
  // Re-render pipeline from last data (avoid re-fetch)
  fetch('/pipeline').then(function(r) { return r.json(); }).then(renderPipeline);
}

// v3.1: 渲染到指定 pane 的版本
function renderPipelineInPane(pane, pipeline) {
  var stages = pipeline.stages || [];
  if (stages.length === 0) {
    pane.innerHTML = '<div style="color:#888;font-size:11px;padding:16px;">No pipeline data.</div>';
    return;
  }
  
  // 直接渲染到 pane，不创建中间 div
  var html = '';
  for (var i = 0; i < stages.length; i++) {
    var stage = stages[i];
    var hasActive = stage.liveAgents.some(function(a) { return a.status === 'running'; });
    var hasError = stage.liveAgents.some(function(a) { return a.status === 'error'; });
    var hasWaiting = stage.liveAgents.some(function(a) { return a.status === 'retrying'; });
    var stageClass = hasActive ? 'has-active' : hasError ? 'has-error' : '';
    var dotClass = hasActive ? 'running' : hasError ? 'error' : hasWaiting ? 'waiting' : 'idle';

    var isExpanded = expandedStages[stage.id] !== false;

    html += '<div class="pipeline-stage ' + stageClass + '">';
    html += '<div class="stage-header" onclick="toggleStage(\'' + stage.id + '\')">';
    html += '<span class="stage-icon">' + (stage.icon || '⚙️') + '</span>';
    html += '<span class="stage-name">' + escapeHtml(stage.name) + '</span>';
    html += '<span class="stage-status-dot ' + dotClass + '"></span>';
    html += '</div>';

    if (isExpanded) {
      html += '<div class="stage-body">';
      if (stage.liveAgents.length === 0) {
        html += '<div class="stage-empty">等待进入此阶段</div>';
      } else {
        for (var j = 0; j < stage.liveAgents.length; j++) {
          var agent = stage.liveAgents[j];
          var aStatus = agent.status || 'idle';
          var aClass = aStatus === 'running' ? 'running' : aStatus === 'error' ? 'error' : aStatus === 'retrying' ? 'retrying' : '';
          html += '<div class="pipeline-agent ' + aClass + '">';
          html += '<span class="pa-dot ' + aStatus + '"></span>';
          html += '<span class="pa-name">' + escapeHtml(agent.name) + '</span>';
          if (agent.currentTask) {
            html += '<span class="pa-task">' + escapeHtml(agent.currentTask) + '</span>';
          }
          if (agent.lastRun) {
            html += '<span class="pa-time">' + formatTime(agent.lastRun) + '</span>';
          }
          html += '</div>';
        }
      }
      if (stage.recentEvents && stage.recentEvents.length > 0) {
        html += '<div class="stage-events">';
        for (var k = 0; k < stage.recentEvents.length; k++) {
          var ev = stage.recentEvents[k];
          var evDotClass = ev.event || 'start';
          html += '<div class="stage-event">';
          html += '<span class="se-time">' + formatTime(ev.time) + '</span>';
          html += '<span class="se-dot ' + evDotClass + '"></span>';
          html += '<span>' + escapeHtml((ev.agent || '') + ' ' + (ev.details || '')) + '</span>';
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    if (i < stages.length - 1) {
      html += '<div class="pipeline-connector"></div>';
    }
  }
  pane.innerHTML = html;
}

function renderKanbanInPane(pane, kanban, milestones) {
  var container = document.createElement('div');
  container.id = 'rpane-kanban';
  pane.appendChild(container);
  renderKanban(kanban, milestones);
}

function renderMilestonesInPane(pane, milestones) {
  var container = document.createElement('div');
  container.id = 'rpane-milestones';
  pane.appendChild(container);
  renderMilestones(milestones);
}

// ====== KANBAN VIEW ======
function renderKanban(kanban, milestones) {
  var el = document.getElementById('rpane-kanban');

  var taskToMs = {};
  (milestones || []).forEach(function(m) {
    (m.tasks || []).forEach(function(tid) { taskToMs[tid] = m; });
  });

  var columns = [
    { key: 'todo', label: 'Todo', items: kanban.todo || [] },
    { key: 'inProgress', label: 'In Progress', items: kanban.inProgress || [] },
    { key: 'blocked', label: 'Blocked', items: kanban.blocked || [] },
    { key: 'review', label: 'Review', items: kanban.review || [] },
    { key: 'testing', label: 'Testing', items: kanban.testing || [] },
    { key: 'done', label: 'Done', items: kanban.done || [] }
  ];

  var total = kanban.total || 0;
  var completion = kanban.completion || 0;

  // Milestone filter
  var filterHtml = '<div class="ms-filter-bar">';
  filterHtml += '<span class="ms-filter-chip' + (!selectedMilestoneId ? ' active' : '') + '" onclick="selectMilestone(null)">All</span>';
  for (var mi = 0; mi < cachedMilestones.length; mi++) {
    var m = cachedMilestones[mi];
    var isActive = selectedMilestoneId === m.id;
    filterHtml += '<span class="ms-filter-chip' + (isActive ? ' active' : '') + '" onclick="selectMilestone(\'' + escapeHtml(m.id) + '\')">' + escapeHtml(m.id || m.name) + '</span>';
  }
  filterHtml += '</div>';

  var html = filterHtml;
  html += '<div class="kanban-header"><div class="section-label" id="kanban-header-label">Kanban</div>';
  html += '<div class="kanban-stats"><strong>' + total + '</strong> tasks · <strong>' + completion + '%</strong> complete</div></div>';

  html += '<div class="kanban-grid">';
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i];
    html += '<div class="kanban-col">';
    html += '<div class="kanban-col-title">' + col.label + ' <span class="kanban-count">' + col.items.length + '</span></div>';

    for (var j = 0; j < col.items.length; j++) {
      var t = col.items[j];
      var pc = (t.priority || 'P1').toLowerCase();
      var ms = taskToMs[t.id];
      var msLabel = ms ? '<span class="task-ms">' + escapeHtml(ms.id || ms.name || '') + '</span>' : '';
      var assignee = t.assignee ? '<span class="task-assignee">@' + escapeHtml(t.assignee) + '</span>' : '';

      html += '<div class="task">';
      html += '<div class="task-title">' + escapeHtml(t.title || t.id) + '</div>';
      html += '<div class="task-meta">';
      html += '<span class="priority ' + pc + '">' + escapeHtml(t.priority || 'P1') + '</span>';
      html += msLabel + assignee;
      html += '</div></div>';
    }

    html += '</div>';
  }
  html += '</div>';

  el.innerHTML = html;
}

function selectMilestone(msId) {
  selectedMilestoneId = msId;
  // Don't re-fetch, just re-render kanban with cached data
  renderKanbanFromCache();
}

function renderKanbanFromCache() {
  // Use last fetched kanban data, filter by selected milestone on client side
  var kanbanMsId = selectedMilestoneId || activeMilestoneId;
  
  // If no milestone selected, use full kanban
  if (!kanbanMsId) {
    renderKanban(window.cachedKanban || {}, cachedMilestones);
    return;
  }
  
  // Filter kanban by milestone
  var milestone = cachedMilestones.find(function(m) { return m.id === kanbanMsId; });
  if (!milestone || !window.cachedKanban) {
    renderKanban({}, cachedMilestones);
    return;
  }
  
  var taskSet = new Set(milestone.tasks || []);
  var filtered = {};
  var cols = ['todo', 'inProgress', 'blocked', 'review', 'testing', 'done'];
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i];
    filtered[col] = (window.cachedKanban[col] || []).filter(function(task) {
      return taskSet.has(task.id);
    });
  }
  
  var total = 0;
  for (var i = 0; i < cols.length; i++) {
    total += filtered[cols[i]].length;
  }
  filtered.total = total;
  filtered.completion = total > 0 ? Math.round((filtered.done.length / total) * 100) : 0;
  
  renderKanban(filtered, cachedMilestones);
}

async function refreshKanban() {
  var kanbanMsId = selectedMilestoneId || activeMilestoneId;
  var kanbanUrl = kanbanMsId ? '/kanban?milestone=' + encodeURIComponent(kanbanMsId) : '/kanban';
  var kanban = await fetch(kanbanUrl).then(function(r) { return r.json(); }).catch(function() {
    return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [], total: 0, completion: 0 };
  });
  renderKanban(kanban, cachedMilestones);
}

// ====== MILESTONES VIEW ======
function renderMilestones(milestones) {
  var el = document.getElementById('rpane-milestones');
  if (!milestones || milestones.length === 0) {
    el.innerHTML = '<div style="color:#666;font-size:11px;padding:8px;">No milestones yet</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < milestones.length; i++) {
    var m = milestones[i];
    var pct = m.progress || 0;
    var statusClass = m.status === 'completed' ? 'done' : m.status === 'active' ? 'active' : 'planned';
    var statusLabel = m.status === 'completed' ? 'done' : m.status === 'active' ? 'active' : 'planned';

    html += '<div class="ms-row ' + statusClass + '">';
    html += '<div class="ms-head">';
    html += '<span class="ms-name">' + escapeHtml((m.id ? m.id + ' ' : '') + (m.name || '')) + '</span>';
    html += '<span class="ms-status-badge ' + statusLabel + '">' + statusLabel + '</span>';
    html += '</div>';
    html += '<div class="ms-progress">';
    html += '<div class="ms-bar-bg"><div class="ms-bar-fill" style="width:' + pct + '%"></div></div>';
    html += '<span class="ms-pct">' + (m.doneCount || 0) + '/' + (m.taskCount || 0) + ' (' + pct + '%)</span>';
    html += '</div>';

    // Task list under each milestone
    if (m.taskDetails && m.taskDetails.length > 0) {
      html += '<div class="ms-tasks">';
      for (var j = 0; j < m.taskDetails.length; j++) {
        var task = m.taskDetails[j];
        var tStatus = task.status || 'todo';
        var isDone = tStatus === 'done' || tStatus === 'completed';
        var isInProg = tStatus === 'in-progress' || tStatus === 'inProgress' || tStatus === 'review' || tStatus === 'testing';
        var dotClass = isDone ? 'done' : isInProg ? 'in-progress' : 'todo';
        var nameClass = isDone ? 'done' : '';

        html += '<div class="ms-task-item">';
        html += '<span class="ms-task-dot ' + dotClass + '"></span>';
        html += '<span class="ms-task-name ' + nameClass + '">' + escapeHtml(task.title || task.id) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
  }

  el.innerHTML = html;
}

// ====== LEFT PANES ======
function renderDoc(docId, docData, gaps) {
  var match = docData.match || 0;
  var gapsList = docData.gaps || [];
  
  // Fallback to gaps object if not in docData
  if (gaps && gaps[docId]) {
    match = gaps[docId].match || gaps[docId].score || match;
    gapsList = gaps[docId].gaps || gapsList;
  }
  
  // 查找 doc 配置（支持新旧格式）
  var docConfig = null;
  if (teamConfig && teamConfig.dashboard && teamConfig.dashboard.left) {
    docConfig = teamConfig.dashboard.left.find(function(d) { return d.id === docId; });
  } else if (teamConfig && teamConfig.docs && teamConfig.docs.items) {
    docConfig = teamConfig.docs.items.find(function(d) { return d.id === docId; });
  }
  var docName = docConfig ? (docConfig.title || docConfig.name) : docId;
  
  var html = renderMatchDisplay(docName + ' Match', match);
  html += renderGapsList(gapsList);
  if (docData.content) html += '<div class="md-content">' + AgenticRender.render(docData.content) + '</div>';
  
  var pane = document.getElementById('pane-' + docId);
  if (pane) pane.innerHTML = html;
  
  // Update tab badge
  var badge = document.getElementById('tab-match-' + docId);
  if (badge) {
    var hasMatch = match != null;
    badge.textContent = hasMatch ? match + '%' : '—';
    badge.className = 'tab-match ' + (!hasMatch ? '' : match >= 80 ? 'green' : match >= 50 ? 'yellow' : 'red');
  }
}

// (Dead code removed: renderVision, renderPRD, renderDBB, renderArchitecture
//  — all rendering now handled by renderComponent with gapKey config)

// --- Shared Render Helpers ---
function renderMatchDisplay(label, value) {
  if (value == null) {
    return '<div class="match-display">' +
      '<div class="match-label">' + label + '</div>' +
      '<div class="match-number" style="color:#888">—</div></div>';
  }
  var colorClass = value > 80 ? 'green' : value > 50 ? 'yellow' : 'red';
  return '<div class="match-display">' +
    '<div class="match-label">' + label + '</div>' +
    '<div class="match-number ' + colorClass + '">' + value + '<span class="pct">%</span></div>' +
    '<div class="match-bar"><div class="match-bar-fill ' + colorClass + '" style="width:' + value + '%"></div></div></div>';
}

function renderGapsList(gapsList) {
  if (!gapsList || gapsList.length === 0) return '';
  var html = '<ul class="gap-list">';
  for (var i = 0; i < gapsList.length; i++) {
    var g = gapsList[i];
    var text = typeof g === 'string' ? g : g.description || g.details || g.gap || g.module || JSON.stringify(g);
    html += '<li>' + escapeHtml(text) + '</li>';
  }
  html += '</ul>';
  return html;
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  var d = new Date(isoStr);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// --- Daemon Toggle ---
document.getElementById('toggle-daemon').addEventListener('click', function() {
  var action = daemonRunning ? 'stop' : 'start';
  fetch('/daemon/' + action, { method: 'POST' }).then(function() {
    setTimeout(refresh, 1000);
  });
});

// --- Auto-refresh ---
setInterval(refresh, 5000);
// refresh() 已在配置加载后调用
