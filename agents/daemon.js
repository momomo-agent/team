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
      if (await this._checkGoalAchieved(config)) {
        var goalDesc = (config.goal && config.goal.description) || 'goal achieved';
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

  async _checkGoalAchieved(config) {
    // 1. Any active tasks? If yes, not done
    try {
      var tasksDir = path.join(this.runtime.projectDir, '.team/tasks');
      if (!fs.existsSync(tasksDir)) return false;
      var files = fs.readdirSync(tasksDir);
      if (files.length === 0) return false;
      for (var j = 0; j < files.length; j++) {
        var taskPath = path.join(tasksDir, files[j]);
        var jsonPath = fs.statSync(taskPath).isDirectory()
          ? path.join(taskPath, 'task.json')
          : taskPath;
        try {
          var t = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (t.status !== 'done' && t.status !== 'cancelled') return false;
        } catch {}
      }
    } catch { return false; }

    // 2. Goal check: condition (facts) AND judgment (LLM)
    //
    //    A goal has two dimensions:
    //    - condition: measurable criteria (match >= 90, tests pass, files exist)
    //    - description: the intent behind the goal ("production-ready", "clean arch")
    //
    //    Both must agree. condition checks facts, LLM checks judgment.
    //    Neither is a fallback for the other — they're two halves of one decision.
    //
    //    condition alone catches "numbers look good but it's actually broken"
    //    LLM alone catches "everything looks fine" when PRD is at 55%
    //    Together: facts AND judgment = confidence to stop.

    var goal = config.goal;
    if (!goal) return true; // No goal, tasks done = done

    // ── Gather current state (shared by both checks) ──
    var state = this._gatherGoalState();

    // ── Facts: evaluate condition expression ──
    var conditionPassed = true;
    if (goal.condition) {
      conditionPassed = this._evaluateGoalCondition(goal.condition);
      this.runtime.log('workflow', 'daemon',
        '[GOAL] condition: ' + goal.condition + ' → ' + conditionPassed);
      if (!conditionPassed) return false; // Facts say no — stop here, don't waste an LLM call
    }

    // ── Judgment: LLM evaluates whether the goal is truly met ──
    if (goal.description) {
      var judgmentPassed = await this._evaluateGoalJudgment(goal, state);
      this.runtime.log('workflow', 'daemon',
        '[GOAL] judgment: ' + judgmentPassed);
      if (!judgmentPassed) return false;
    }

    // Both passed (or only one dimension was defined and it passed)
    this.runtime.log('workflow', 'daemon',
      '[GOAL] ✅ Both facts and judgment agree — goal achieved');
    return true;
  }

  /**
   * Gather current project state for goal evaluation.
   * Used by both condition eval and LLM judgment.
   */
  _gatherGoalState() {
    var gapsDir = path.join(this.runtime.projectDir, '.team/gaps');
    var gapSummary = {};
    var gapDetails = '';
    if (fs.existsSync(gapsDir)) {
      var gapFiles = fs.readdirSync(gapsDir).filter(function(f) { return f.endsWith('.json'); });
      for (var i = 0; i < gapFiles.length; i++) {
        try {
          var gap = JSON.parse(fs.readFileSync(path.join(gapsDir, gapFiles[i]), 'utf8'));
          var name = gapFiles[i].replace('.json', '');
          gapSummary[name] = gap.match || 0;
          var criticals = (gap.gaps || []).filter(function(g) {
            return g.severity === 'critical' && g.status !== 'implemented';
          });
          var partials = (gap.gaps || []).filter(function(g) {
            return g.status === 'partial';
          });
          gapDetails += name + ': ' + (gap.match || 0) + '%';
          if (criticals.length > 0) gapDetails += ' (' + criticals.length + ' critical)';
          if (partials.length > 0) gapDetails += ' (' + partials.length + ' partial)';
          gapDetails += '\n';
          // Include specific gap descriptions for LLM context
          criticals.forEach(function(c) {
            gapDetails += '  ⚠️ ' + (c.description || c.name || 'unnamed') + '\n';
          });
          partials.forEach(function(p) {
            gapDetails += '  ◐ ' + (p.description || p.name || 'unnamed') + '\n';
          });
        } catch {}
      }
    }
    return { gapSummary: gapSummary, gapDetails: gapDetails };
  }

  /**
   * Evaluate goal condition expression using the same API as workflow context.
   */
  _evaluateGoalCondition(expr) {
    var self = this;
    var gaps = {
      read: function(name) {
        var gapPath = path.join(self.runtime.projectDir, '.team/gaps', name + '.json');
        try { return JSON.parse(fs.readFileSync(gapPath, 'utf8')); }
        catch { return { match: 0 }; }
      }
    };
    var tasks = {
      byStatus: function(status) {
        var kanban = self.runtime.getKanban();
        return kanban[status] || [];
      }
    };
    var milestones = {
      active: function() {
        var data = self.runtime.getGroups();
        var ms = (data.groups || data.milestones || []);
        return ms.find(function(m) {
          return m.status === 'active' || m.status === 'in-progress';
        }) || null;
      }
    };
    var files = {
      exists: function(p) {
        return fs.existsSync(path.join(self.runtime.projectDir, p));
      }
    };

    try {
      var fn = new Function('gaps', 'tasks', 'milestones', 'files', 'return ' + expr);
      return !!fn(gaps, tasks, milestones, files);
    } catch (err) {
      this.runtime.log('error', 'daemon',
        '[GOAL] Failed to evaluate condition: ' + err.message);
      return false;
    }
  }

  /**
   * LLM judgment: given the goal description and current state,
   * does the project truly meet the goal's intent?
   *
   * This is not a fallback — it's the qualitative half of the decision.
   * The prompt is structured to prevent false positives:
   * - Shows exact numbers so LLM can't hallucinate
   * - Asks for reasoning before yes/no
   * - Biases toward "no" when uncertain
   */
  async _evaluateGoalJudgment(goal, state) {
    var prompt =
      '# Goal Achievement Review\n\n' +
      '## Goal\n' + (goal.description || '(no description)') + '\n\n' +
      (goal.condition ? '## Quantitative Criteria\n`' + goal.condition + '`\n(Already verified as passing.)\n\n' : '') +
      '## Current Project State\n' + state.gapDetails + '\n' +
      '## Instructions\n' +
      'You are reviewing whether this project has genuinely achieved its goal.\n' +
      'The numbers above are facts — do not dispute them.\n' +
      'But numbers passing thresholds does not automatically mean the goal is met.\n\n' +
      'Consider:\n' +
      '- Are there critical or partial gaps that undermine the goal\'s intent?\n' +
      '- Do the remaining issues matter for what the goal is trying to achieve?\n' +
      '- Would a reasonable engineer say "yes, this is done"?\n\n' +
      'If uncertain, say NO. False negatives (continuing work) are cheaper than false positives (stopping too early).\n\n' +
      'Answer with one line of reasoning, then YES or NO on the last line.\n';

    var tmpFile = '/tmp/team-goal-judgment-' + Date.now() + '.txt';
    try {
      fs.writeFileSync(tmpFile, prompt);
      var { execSync } = require('child_process');
      var result = execSync('llm --max-tokens 100 < ' + tmpFile, {
        encoding: 'utf8', timeout: 30000
      }).trim();
      fs.unlinkSync(tmpFile);

      // Extract YES/NO from last line
      var lines = result.split('\n').filter(function(l) { return l.trim(); });
      var lastLine = (lines[lines.length - 1] || '').trim().toUpperCase();
      var reasoning = lines.slice(0, -1).join(' ').trim();

      this.runtime.log('workflow', 'daemon',
        '[GOAL] LLM reasoning: ' + (reasoning || '(none)').slice(0, 200));
      this.runtime.log('workflow', 'daemon',
        '[GOAL] LLM verdict: ' + lastLine);

      return lastLine === 'YES';
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch {}
      // LLM unavailable — cannot make judgment call, don't stop
      this.runtime.log('workflow', 'daemon',
        '[GOAL] LLM unavailable (' + err.message + '). Cannot judge — continuing.');
      return false;
    }
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
