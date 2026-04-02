var daemonRunning = false;
var activeMilestoneId = null;
var selectedMilestoneId = null; // user-clicked milestone for kanban

// --- Data Loading ---
async function refresh() {
  try {
    var results = await Promise.all([
      fetch('/status').then(function(r) { return r.json(); }),
      fetch('/gaps').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/vision').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/architecture').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/milestones').then(function(r) { return r.json(); }).catch(function() { return { milestones: [] }; }),
      fetch('/agents').then(function(r) { return r.json(); }).catch(function() { return {}; })
    ]);

    var status = results[0];
    var gaps = results[1];
    var vision = results[2];
    var arch = results[3];
    var msData = results[4];
    var agents = results[5];

    var milestones = msData.milestones || [];

    // Find active milestone
    var activeMs = milestones.find(function(m) { return m.status === 'active'; });
    activeMilestoneId = activeMs ? activeMs.id : null;

    // Fetch kanban for selected or active milestone
    var kanbanMsId = selectedMilestoneId || activeMilestoneId;
    var kanbanUrl = kanbanMsId ? '/kanban?milestone=' + encodeURIComponent(kanbanMsId) : '/kanban';
    var kanban = await fetch(kanbanUrl).then(function(r) { return r.json(); }).catch(function() {
      return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [], total: 0, completion: 0 };
    });

    renderTopBar(status, agents);
    renderVision(vision, gaps);
    renderArchitecture(arch, gaps);
    renderMilestones(milestones);
    renderKanban(kanban, milestones);

    // Update kanban section title with selected milestone
    var kanbanMsId = selectedMilestoneId || activeMilestoneId;
    var kanbanMs = milestones.find(function(m) { return m.id === kanbanMsId; });
    var kanbanLabel = document.querySelector('[data-col="milestones"] .section-title:last-of-type .col-label');
    if (kanbanLabel) {
      kanbanLabel.textContent = kanbanMs ? 'Kanban — ' + (kanbanMs.id || '') + ' ' + (kanbanMs.name || '') : 'Kanban';
    }
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

// --- Vision (left column) ---
function renderVision(vision, gaps) {
  var match = 0;
  var gapsList = [];

  if (gaps && gaps.vision) {
    match = gaps.vision.match || 0;
    gapsList = gaps.vision.gaps || [];
  } else {
    match = vision.match || 0;
  }

  var html = renderMatchDisplay('Match', match);

  // Gaps bullet list
  if (gapsList.length > 0) {
    html += '<ul class="gap-list">';
    for (var i = 0; i < gapsList.length; i++) {
      html += '<li>' + escapeHtml(typeof gapsList[i] === 'string' ? gapsList[i] : gapsList[i].description || gapsList[i].gap || JSON.stringify(gapsList[i])) + '</li>';
    }
    html += '</ul>';
  }

  // Collapsible markdown content
  if (vision.content) {
    html += '<span class="collapsible-toggle" onclick="toggleCollapsible(this)">Show VISION.md</span>';
    html += '<div class="collapsible-content"><div class="md-content">' + marked.parse(vision.content) + '</div></div>';
  }

  document.getElementById('vision-content').innerHTML = html;
}

// --- Architecture (left column) ---
function renderArchitecture(arch, gaps) {
  var match = 0;
  var gapsList = [];

  if (gaps && gaps.architecture) {
    match = gaps.architecture.match || 0;
    gapsList = gaps.architecture.gaps || [];
  } else {
    match = arch.match || 0;
  }

  var el = document.getElementById('architecture-content');
  var html = renderMatchDisplay('Match', match);

  // Gaps bullet list
  if (gapsList.length > 0) {
    html += '<ul class="gap-list">';
    for (var i = 0; i < gapsList.length; i++) {
      html += '<li>' + escapeHtml(typeof gapsList[i] === 'string' ? gapsList[i] : gapsList[i].description || gapsList[i].gap || JSON.stringify(gapsList[i])) + '</li>';
    }
    html += '</ul>';
  }

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
    html += '<div class="mermaid">' + arch.diagram + '</div>';
  }

  el.innerHTML = html;

  if (arch.diagram) {
    try { mermaid.run({ nodes: el.querySelectorAll('.mermaid') }); } catch (e) {}
  }
}

// --- Match Display (large number + colored bar) ---
function renderMatchDisplay(label, value) {
  var colorClass = value > 80 ? 'green' : value > 50 ? 'yellow' : 'red';
  return '<div class="match-display">' +
    '<div class="match-label">' + label + '</div>' +
    '<div class="match-number ' + colorClass + '">' + value + '<span class="pct">%</span></div>' +
    '<div class="match-bar"><div class="match-bar-fill ' + colorClass + '" style="width:' + value + '%"></div></div>' +
    '</div>';
}

// --- Milestones (right column) ---
function renderMilestones(milestones) {
  var el = document.getElementById('milestone-content');
  if (!milestones || milestones.length === 0) {
    el.innerHTML = '<div style="color:#666;font-size:11px;">No milestones yet</div>';
    return;
  }

  el.innerHTML = '<div class="ms-list">' +
    milestones.map(function(m) {
      var pct = m.progress || 0;
      var statusClass = m.status === 'completed' ? 'done' : m.status === 'active' ? 'active' : 'planned';
      var statusLabel = m.status === 'completed' ? 'done' : m.status === 'active' ? 'active' : 'planned';
      var kanbanMsId = selectedMilestoneId || activeMilestoneId;
      var selectedClass = (m.id === kanbanMsId) ? ' selected' : '';
      return '<div class="ms-card ' + statusClass + selectedClass + '" data-ms-id="' + escapeHtml(m.id) + '" onclick="selectMilestone(\'' + escapeHtml(m.id) + '\')" style="cursor:pointer;">' +
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

// --- Kanban (right column, active milestone only) ---
function renderKanban(kanban, milestones) {
  var el = document.getElementById('kanban-content');

  // Build task→milestone mapping
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

  // Stats row
  var html = '<div class="kanban-stats">' +
    '<div class="kanban-stat"><strong>' + total + '</strong>tasks</div>' +
    '<div class="kanban-stat"><strong>' + completion + '%</strong>complete</div>' +
  '</div>';

  // 6-column kanban grid
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

// --- Select milestone to show its kanban ---
function selectMilestone(msId) {
  selectedMilestoneId = (selectedMilestoneId === msId) ? null : msId; // toggle
  refresh();
}

// --- Collapsible toggle ---
function toggleCollapsible(el) {
  var content = el.nextElementSibling;
  var isOpen = content.classList.contains('open');
  content.classList.toggle('open');
  el.textContent = isOpen ? 'Show VISION.md' : 'Hide VISION.md';
}

// --- Escape HTML ---
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

// --- Column Focus: double-click title to expand, X to close ---
document.querySelectorAll('.col-label').forEach(function(label) {
  label.addEventListener('dblclick', function() {
    var grid = document.getElementById('main-grid');
    var thisCol = label.closest('.col');
    var cols = document.querySelectorAll('.col');

    cols.forEach(function(c) {
      if (c === thisCol) {
        c.classList.remove('hidden');
        c.querySelector('.col-close').style.display = '';
      } else {
        c.classList.add('hidden');
      }
    });
    grid.classList.add('focused');
  });
});

document.querySelectorAll('.col-close').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var grid = document.getElementById('main-grid');
    document.querySelectorAll('.col').forEach(function(c) {
      c.classList.remove('hidden');
      c.querySelector('.col-close').style.display = 'none';
    });
    grid.classList.remove('focused');
  });
});

// --- Auto-refresh every 5 seconds ---
setInterval(refresh, 5000);
refresh();
