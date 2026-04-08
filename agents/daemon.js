#!/usr/bin/env node
/**
 * DevTeam Daemon — cron + process guard
 *
 * Only two jobs:
 *   1. Periodically call engine.execute()
 *   2. Watchdog: kill stuck processes, reset states
 *
 * All business logic lives in:
 *   - runtime.js (capabilities: agent exec, tasks, milestones, CR, git, notify)
 *   - workflow-engine.js (flow control: nodes, steps, loops, branches, checkpoint)
 *   - config files (what to run, in what order)
 */

const fs = require('fs');
const path = require('path');
const WorkflowEngine = require('./workflow-engine');
const Runtime = require('../lib/runtime');
const DevTeamMonitor = require('./monitor');

const SAFETY_INTERVAL = 10 * 60 * 1000; // 10 min
const AGENT_TIMEOUT = 65 * 60 * 1000; // 65 min (matches runtime.js)
const DEVTEAM_ROOT = path.join(__dirname, '..');
const DEFAULT_WORKFLOW = 'dev-team';
const DEFAULT_CONFIG_PATH = path.join(DEVTEAM_ROOT, 'configs', DEFAULT_WORKFLOW, 'config.json');

class TeamDaemon {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.running = false;
    this.busy = false;
    this._busySince = 0;
    this.perfMonitorInterval = null;

    // Runtime handles all capabilities
    this.runtime = new Runtime(projectDir);
  }

  // ─── Config Loading ───

  loadWorkflowConfig() {
    var projectConfigPath = path.join(this.projectDir, '.team/config.json');
    var projectConfig = {};
    try { projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')); } catch {}

    var defaultConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

    return {
      version: projectConfig.version || defaultConfig.version,
      workflow: projectConfig.workflow || defaultConfig.workflow,
      agents: projectConfig.agents || defaultConfig.agents,
      git: projectConfig.git || defaultConfig.git || {},
      notify: projectConfig.notify || defaultConfig.notify || {},
      groups: projectConfig.groups || defaultConfig.groups || {},
      cr: projectConfig.cr || defaultConfig.cr || {},
      _workflow: projectConfig._workflow || defaultConfig._workflow || DEFAULT_WORKFLOW
    };
  }

  // ─── Main Loop ───

  async run() {
    // Watchdog
    if (this.busy) {
      var busyElapsed = Date.now() - this._busySince;
      var watchdogLimit = AGENT_TIMEOUT + 10 * 60 * 1000;
      if (busyElapsed > watchdogLimit) {
        this.runtime.log('error', 'daemon', 'Watchdog: busy for ' + Math.round(busyElapsed/60000) + 'min, force reset');
        this.runtime.killOrphanAgents();
        this.busy = false;
      } else {
        this.runtime.log('agent_start', 'daemon', 'Still busy (' + Math.round(busyElapsed/60000) + 'min), skipping');
        return;
      }
    }

    this.busy = true;
    this._busySince = Date.now();

    try {
      var config = this.loadWorkflowConfig();
      this.runtime.config = config;
      var engine = new WorkflowEngine(config, this.runtime);
      await engine.execute();

      // Auto-stop when goal achieved
      if (this._checkAllDone()) {
        var goalDesc = (config.goal && config.goal.description) || 'all tasks done + monitors ≥90%';
        this.runtime.log('workflow', 'daemon', '🎉 Goal achieved: ' + goalDesc + ' — shutting down');
        this.stop();
        return;
      }
    } catch (err) {
      this.runtime.log('error', 'daemon', 'Error in main loop: ' + err.message);
    } finally {
      this.busy = false;
    }
  }

  _checkAllDone() {
    // Goal: all matches >= 90% AND zero critical gaps AND all tasks done
    try {
      var gapsDir = path.join(this.runtime.projectDir, '.team/gaps');
      if (fs.existsSync(gapsDir)) {
        var coreGaps = ['prd.json', 'vision.json', 'dbb.json', 'architecture.json'];
        for (var i = 0; i < coreGaps.length; i++) {
          var gapPath = path.join(gapsDir, coreGaps[i]);
          if (!fs.existsSync(gapPath)) continue;
          try {
            var gap = JSON.parse(fs.readFileSync(gapPath, 'utf8'));
            // Match >= 90%
            var match = gap.match || gap.matchPercent || gap.percentage;
            if (match != null && match < 90) return false;
            // Zero critical gaps
            var gaps = gap.gaps || [];
            for (var k = 0; k < gaps.length; k++) {
              if (gaps[k].severity === 'critical' && gaps[k].status !== 'implemented') return false;
            }
          } catch {}
        }
      }

      // Check all tasks done
      var tasksDir = path.join(this.runtime.projectDir, '.team/tasks');
      if (!fs.existsSync(tasksDir)) return false;
      var files = fs.readdirSync(tasksDir);
      if (files.length === 0) return false;
      for (var j = 0; j < files.length; j++) {
        var taskPath = path.join(tasksDir, files[j]);
        var jsonPath = fs.statSync(taskPath).isDirectory()
          ? path.join(taskPath, 'task.json')
          : taskPath;
        var t = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (t.status !== 'done' && t.status !== 'cancelled') return false;
      }
      return true;
    } catch { return false; }
  }

  // ─── Start / Stop ───

  start() {
    if (this.running) return;

    var config = this.loadWorkflowConfig();
    this.runtime.config = config;

    // ─── Validate workflow before starting ───
    var validator = require('../lib/workflow-validator');
    var workflowName = config._workflow || 'dev-team';
    var configDir = path.join(DEVTEAM_ROOT, 'configs', workflowName);
    var validResult = validator.validate(config, { configDir: configDir, projectDir: this.projectDir });
    if (!validResult.valid) {
      console.error('\n❌ Workflow validation failed:');
      validResult.errors.forEach(function(e) { console.error('  ' + e.toString()); });
      console.error('\nFix errors before starting daemon.\n');
      process.exit(1);
    }
    if (validResult.warnings.length > 0) {
      validResult.warnings.forEach(function(e) {
        this.runtime.log('workflow', 'validator', e.toString());
      }.bind(this));
    }

    // Clean up from previous runs
    this.runtime.killOrphanAgents();
    this.runtime.resetStuckAgents();

    // Check required files
    var requiredFiles = (config.requiredFiles) || [];
    for (var i = 0; i < requiredFiles.length; i++) {
      if (!fs.existsSync(path.join(this.projectDir, requiredFiles[i]))) {
        console.error('\n❌ ERROR: ' + requiredFiles[i] + ' not found');
        console.error('   Path: ' + this.projectDir + '\n');
        process.exit(1);
      }
    }

    this.running = true;
    this.runtime.log('agent_start', 'daemon',
      'DevTeam daemon started (safety=' + (SAFETY_INTERVAL / 1000) + 's, timeout=' + (AGENT_TIMEOUT / 1000) + 's)');

    // Health monitor — pass runtime as the "daemon" interface monitor expects
    this.healthMonitor = new DevTeamMonitor({
      projectDir: this.projectDir,
      log: (...args) => this.runtime.log(...args),
      getKanban: () => this.runtime.getKanban(),
      eventBus: this.runtime.eventBus
    });
    this.healthMonitor.start();

    // Ensure .team dir
    var teamDir = path.join(this.projectDir, '.team');
    if (!fs.existsSync(teamDir)) fs.mkdirSync(teamDir, { recursive: true });

    // PID file
    fs.writeFileSync(path.join(teamDir, 'daemon.pid'), process.pid.toString());

    // Perf monitoring
    var self = this;
    this.perfMonitorInterval = setInterval(() => {
      const mem = process.memoryUsage();
      self.runtime.log('perf', 'daemon', JSON.stringify({
        rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
        uptime: Math.round(process.uptime()) + 's'
      }));
    }, 5 * 60 * 1000);

    // Go
    this.run();

    this.timer = setInterval(function() {
      if (self.running) self.run();
    }, SAFETY_INTERVAL);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.perfMonitorInterval) clearInterval(this.perfMonitorInterval);
    if (this.healthMonitor) this.healthMonitor.stop();
    // Reset all agent statuses to idle
    this.runtime.resetStuckAgents();
    var pidPath = path.join(this.projectDir, '.team/daemon.pid');
    try { fs.unlinkSync(pidPath); } catch {}
    this.runtime.log('agent_complete', 'daemon', 'DevTeam daemon stopped');
  }
}

// ─── Entry Point ───

var projectDir = process.argv[2] || process.cwd();
var daemon = new TeamDaemon(projectDir);

process.on('uncaughtException', function(err) {
  console.error('[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] Uncaught:', err.message);
});
process.on('unhandledRejection', function(err) {
  console.error('[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] Unhandled:', err && err.message ? err.message : err);
});

module.exports = TeamDaemon;

if (require.main === module) {
  process.on('SIGINT', function() { daemon.stop(); process.exit(0); });
  process.on('SIGTERM', function() { daemon.stop(); process.exit(0); });
  daemon.start();
}
