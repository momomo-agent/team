var daemonRunning = false;
var activeMilestoneId = null;
var selectedMilestoneId = null;
var activeTab = 'vision';

// --- Tab Switching ---
document.getElementById('tab-bar').addEventListener('click', function(e) {
  var tab = e.target.closest('.tab');
  if (!tab) return;
  var tabName = tab.dataset.tab;
  if (!tabName) return;
  activeTab = tabName;
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
  tab.classList.add('active');
  var pane = document.getElementById('pane-' + tabName);
  if (pane) pane.classList.add('active');
});

// --- Data Loading ---
async function refresh() {
  try {
    var results = await Promise.all([
      fetch('/status').then(function(r) { return r.json(); }),
      fetch('/gaps').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/vision').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/architecture').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/milestones').then(function(r) { return r.json(); }).catch(function() { return { milestones: [] }; }),
      fetch('/agents').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/prd').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/dbb').then(function(r) { return r.json(); }).catch(function() { return {}; })
    ]);

    var status = results[0];
    var gaps = results[1];
    var vision = results[2];
    var arch = results[3];
    var msData = results[4];
    var agents = results[5];
    var prd = results[6];
    var dbb = results[7];

    var milestones = msData.milestones || [];
    var activeMs = milestones.find(function(m) { return m.status === 'active'; });
    activeMilestoneId = activeMs ? activeMs.id : null;

    var kanbanMsId = selectedMilestoneId || activeMilestoneId;
    var kanbanUrl = kanbanMsId ? '/kanban?milestone=' + encodeURIComponent(kanbanMsId) : '/kanban';
    var kanban = await fetch(kanbanUrl).then(function(r) { return r.json(); }).catch(function() {
      return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [], total: 0, completion: 0 };
    });

    renderTopBar(status, agents);
    updateTabMatches(status, gaps);
    renderVision(vision, gaps);
    renderPRD(prd, gaps);
    renderDBB(dbb, gaps);
    renderArchitecture(arch, gaps);
    renderMilestones(milestones);
    renderKanban(kanban, milestones);

    // Update kanban header
    var kanbanMs = milestones.find(function(m) { return m.id === kanbanMsId; });
    document.getElementById('kanban-header').textContent = kanbanMs ? 'Kanban — ' + kanbanMs.id + ' ' + (kanbanMs.name || '') : 'Kanban';
  } catch (err) {
    console.error('Refresh error:', err);
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

  renderAgents(agents);
}

// --- Tab match badges ---
function updateTabMatches(status, gaps) {
  var matchData = status.match || {};
  var tabs = { vision: matchData.vision, prd: matchData.prd, dbb: matchData.dbb || 0, arch: matchData.architecture };

  Object.keys(tabs).forEach(function(key) {
    var val = tabs[key] || 0;
    var el = document.getElementById('tab-match-' + key);
    if (!el) return;
    var colorClass = val > 80 ? 'green' : val > 50 ? 'yellow' : 'red';
    el.textContent = val + '%';
    el.className = 'tab-match ' + colorClass;
  });
}

// --- Agents ---
function renderAgents(agents) {
  var names = {
    architect: '\uD83C\uDFD7\uFE0F Arch',
    vision_monitor: '\uD83D\uDC41\uFE0F Vision',
    prd_monitor: '\uD83D\uDCCB PRD',
    dbb_monitor: '\u2705 DBB',
    arch_monitor: '\uD83D\uDCCA Arch',
    pm: '\uD83D\uDCCB PM',
    tech_lead: '\uD83D\uDD27 Lead'
  };

  var bar = document.getElementById('agent-bar');
  var countEl = document.getElementById('agent-count');
  var entries = Object.entries(agents);

  if (entries.length === 0) {
    bar.innerHTML = '<span style="color:#666;font-size:11px;">No agents</span>';
    countEl.textContent = '';
    return;
  }

  var activeCount = entries.filter(function(e) { return e[1].status === 'running'; }).length;
  countEl.textContent = activeCount > 0 ? activeCount + ' active' : '';

  bar.innerHTML = entries.map(function(entry) {
    var name = entry[0];
    var info = entry[1];
    var label = names[name] || (name.startsWith('developer') ? '\uD83D\uDCBB ' + name : name.startsWith('tester') ? '\uD83E\uDDEA ' + name : name);
    var dotClass = info.status === 'running' ? 'running' : info.status === 'error' ? 'error' : '';
    var taskText = info.status === 'running' && info.currentTask ? '<span class="agent-task-text">' + escapeHtml(info.currentTask) + '</span>' : '';
    return '<div class="agent-chip"><span class="dot ' + dotClass + '"></span>' + escapeHtml(label) + taskText + '</div>';
  }).join('');
}

// --- Vision Pane ---
function renderVision(vision, gaps) {
  var match = 0;
  var gapsList = [];

  if (gaps && gaps.vision) {
    match = gaps.vision.match || gaps.vision.coverage || 0;
    gapsList = gaps.vision.gaps || [];
  }

  var html = renderMatchDisplay('Vision Match', match);
  html += renderGapsList(gapsList);

  if (vision.content) {
    html += '<div class="md-content">' + marked.parse(vision.content) + '</div>';
  }

  document.getElementById('pane-vision').innerHTML = html;
}

// --- PRD Pane ---
function renderPRD(prd, gaps) {
  var match = 0;
  var gapsList = [];

  if (gaps && gaps.prd) {
    match = gaps.prd.match || gaps.prd.coverage || 0;
    gapsList = gaps.prd.gaps || [];
  }

  var html = renderMatchDisplay('PRD Match', match);
  html += renderGapsList(gapsList);

  if (prd && prd.content) {
    html += '<div class="md-content">' + marked.parse(prd.content) + '</div>';
  }

  document.getElementById('pane-prd').innerHTML = html;
}

// --- DBB Pane ---
function renderDBB(dbb, gaps) {
  var match = 0;
  var gapsList = [];

  if (gaps && gaps.dbb) {
    match = gaps.dbb.match || gaps.dbb.coverage || 0;
    gapsList = gaps.dbb.gaps || [];
  }

  var html = renderMatchDisplay('DBB Match', match);
  html += renderGapsList(gapsList);

  if (dbb && dbb.content) {
    html += '<div class="md-content">' + marked.parse(dbb.content) + '</div>';
  }

  document.getElementById('pane-dbb').innerHTML = html;
}

// --- Architecture Pane ---
function renderArchitecture(arch, gaps) {
  var match = 0;
  var gapsList = [];

  if (gaps && gaps.architecture) {
    match = gaps.architecture.match || gaps.architecture.coverage || 0;
    gapsList = gaps.architecture.gaps || [];
  }

  var el = document.getElementById('pane-arch');
  var html = renderMatchDisplay('Architecture Match', match);
  html += renderGapsList(gapsList);

  // Module completion list
  var modules = arch.modules || [];
  if (modules.length > 0) {
    html += '<div class="module-list">';
    for (var j = 0; j < modules.length; j++) {
      var mod = modules[j];
      var statusCls = mod.status === 'implemented' ? 'implemented' : mod.status === 'missing' ? 'missing' : 'partial';
      html += '<div class="module-item">' +
        '<span class="module-name">' + escapeHtml(mod.name) + '</span>' +
        '<span class="module-status ' + statusCls + '">' + escapeHtml(mod.status || 'partial') + '</span>' +
        '<span class="module-coverage">' + (mod.coverage || 0) + '%</span>' +
        '</div>';
    }
    html += '</div>';
  }

  // Mermaid diagram
  if (arch.diagram) {
    html += '<div class="mermaid-wrap"><div class="mermaid">' + escapeHtml(arch.diagram) + '</div></div>';
  }

  // Architecture markdown content
  if (arch.content) {
    html += '<div class="md-content">' + marked.parse(arch.content) + '</div>';
  }

  el.innerHTML = html;

  // Render mermaid
  if (arch.diagram) {
    try { mermaid.run({ nodes: el.querySelectorAll('.mermaid') }); } catch (e) { console.error('mermaid error:', e); }
  }
}

// --- Shared Render Helpers ---
function renderMatchDisplay(label, value) {
  var colorClass = value > 80 ? 'green' : value > 50 ? 'yellow' : 'red';
  return '<div class="match-display">' +
    '<div class="match-label">' + label + '</div>' +
    '<div class="match-number ' + colorClass + '">' + value + '<span class="pct">%</span></div>' +
    '<div class="match-bar"><div class="match-bar-fill ' + colorClass + '" style="width:' + value + '%"></div></div>' +
    '</div>';
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

// --- Milestones ---
function renderMilestones(milestones) {
  var el = document.getElementById('milestone-content');
  if (!milestones || milestones.length === 0) {
    el.innerHTML = '<div style="color:#666;font-size:11px;padding:8px;">No milestones yet</div>';
    return;
  }

  el.innerHTML = '<div class="ms-list">' +
    milestones.map(function(m) {
      var pct = m.progress || 0;
      var statusClass = m.status === 'completed' ? 'done' : m.status === 'active' ? 'active' : 'planned';
      var statusLabel = m.status === 'completed' ? 'done' : m.status === 'active' ? 'active' : 'planned';
      var kanbanMsId = selectedMilestoneId || activeMilestoneId;
      var selectedClass = (m.id === kanbanMsId) ? ' selected' : '';
      return '<div class="ms-card ' + statusClass + selectedClass + '" onclick="selectMilestone(\'' + escapeHtml(m.id) + '\')">' +
        '<div class="ms-head">' +
          '<span class="ms-name">' + escapeHtml((m.id ? m.id + ' ' : '') + (m.name || '')) + '</span>' +
          '<span class="ms-status-badge ' + statusLabel + '">' + statusLabel + '</span>' +
        '</div>' +
        '<div class="ms-progress">' +
          '<div class="ms-bar-bg"><div class="ms-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="ms-pct">' + (m.doneCount || 0) + '/' + (m.taskCount || 0) + ' (' + pct + '%)</span>' +
        '</div>' +
      '</div>';
    }).join('') +
  '</div>';
}

function selectMilestone(msId) {
  selectedMilestoneId = (selectedMilestoneId === msId) ? null : msId;
  refresh();
}

// --- Kanban ---
function renderKanban(kanban, milestones) {
  var el = document.getElementById('kanban-content');

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

  var html = '<div class="kanban-stats">' +
    '<div class="kanban-stat"><strong>' + total + '</strong>tasks</div>' +
    '<div class="kanban-stat"><strong>' + completion + '%</strong>complete</div>' +
  '</div>';

  html += '<div class="kanban-grid">';
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i];
    html += '<div class="kanban-col">' +
      '<div class="kanban-col-title">' + col.label + ' <span class="kanban-count">' + col.items.length + '</span></div>';

    for (var j = 0; j < col.items.length; j++) {
      var t = col.items[j];
      var pc = (t.priority || 'P1').toLowerCase();
      var ms = taskToMs[t.id];
      var msLabel = ms ? '<span class="task-ms">' + escapeHtml(ms.id || ms.name || '') + '</span>' : '';
      var assignee = t.assignee ? '<span class="task-assignee">@' + escapeHtml(t.assignee) + '</span>' : '';

      html += '<div class="task">' +
        '<div class="task-title">' + escapeHtml(t.title || t.id) + '</div>' +
        '<div class="task-meta">' +
          '<span class="priority ' + pc + '">' + escapeHtml(t.priority || 'P1') + '</span>' +
          msLabel + assignee +
        '</div>' +
      '</div>';
    }

    html += '</div>';
  }
  html += '</div>';

  el.innerHTML = html;
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Daemon Toggle ---
document.getElementById('toggle-daemon').addEventListener('click', function() {
  var action = daemonRunning ? 'stop' : 'start';
  fetch('/daemon/' + action, { method: 'POST' }).then(function() {
    setTimeout(refresh, 1000);
  });
});

// --- Auto-refresh every 5 seconds ---
setInterval(refresh, 5000);
refresh();

// --- Activity Log (Task 8) ---
var activityLogCollapsed = true;

document.getElementById('activity-log-toggle').addEventListener('click', function() {
  activityLogCollapsed = !activityLogCollapsed;
  var content = document.getElementById('activity-log-content');
  var arrow = document.getElementById('activity-log-arrow');
  if (activityLogCollapsed) {
    content.style.display = 'none';
    arrow.textContent = '\u25B6';
  } else {
    content.style.display = 'block';
    arrow.textContent = '\u25BC';
    loadHistory();
  }
});

async function loadHistory() {
  try {
    var history = await fetch('/history').then(function(r) { return r.json(); }).catch(function() { return []; });
    renderHistory(history);
  } catch (err) {
    console.error('History load error:', err);
  }
}

function renderHistory(history) {
  var el = document.getElementById('activity-log-content');
  if (!history || history.length === 0) {
    el.innerHTML = '<div style="color:#666;font-size:11px;padding:8px;">No activity yet</div>';
    return;
  }

  // Show last 20 events, newest first
  var recent = history.slice(-20).reverse();

  var html = '<div class="activity-list">';
  for (var i = 0; i < recent.length; i++) {
    var entry = recent[i];
    var eventColor = 'blue';
    if (entry.event === 'agent_complete' || entry.event === 'milestone_complete') eventColor = 'green';
    else if (entry.event === 'error') eventColor = 'red';
    else if (entry.event === 'agent_start') eventColor = 'blue';
    else if (entry.event === 'cr_created') eventColor = 'yellow';

    var timeStr = '';
    if (entry.time) {
      var d = new Date(entry.time);
      timeStr = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    }

    html += '<div class="activity-entry">' +
      '<span class="activity-time">' + escapeHtml(timeStr) + '</span>' +
      '<span class="activity-event ' + eventColor + '">' + escapeHtml(entry.event || '') + '</span>' +
      '<span class="activity-agent">' + escapeHtml(entry.agent || '') + '</span>' +
      '<span class="activity-details">' + escapeHtml(entry.details || '') + '</span>' +
    '</div>';
  }
  html += '</div>';

  el.innerHTML = html;
}

// Auto-refresh history if expanded
setInterval(function() {
  if (!activityLogCollapsed) {
    loadHistory();
  }
}, 5000);
