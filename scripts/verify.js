#!/usr/bin/env node
/**
 * verify.js — Run project-level verification commands.
 * 
 * Usage: node verify.js <step>
 *   step: build | test | e2e
 * 
 * Reads .team/verify.json for commands.
 * On failure: writes error log to .team/verify-errors/<timestamp>-<step>.log
 * Exit 0 on success or if no verify command configured.
 * Exit 1 on failure (workflow can branch on this).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const step = process.argv[2]; // build | test | e2e
if (!step) {
  console.error('Usage: verify.js <build|test|e2e>');
  process.exit(1);
}

// Find project root (walk up to find .team/)
let projectDir = process.cwd();
while (projectDir !== path.dirname(projectDir)) {
  if (fs.existsSync(path.join(projectDir, '.team/verify.json'))) break;
  projectDir = path.dirname(projectDir);
}

const verifyPath = path.join(projectDir, '.team/verify.json');
if (!fs.existsSync(verifyPath)) {
  console.log(`[verify] No verify.json found, skipping ${step}`);
  process.exit(0);
}

const verify = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
const command = verify[step];

if (!command) {
  console.log(`[verify] No ${step} command configured, skipping`);
  process.exit(0);
}

console.log(`[verify] Running ${step}: ${command}`);

try {
  const output = execSync(command, {
    cwd: projectDir,
    stdio: 'pipe',
    timeout: step === 'e2e' ? 300000 : 120000, // e2e gets 5min, others 2min
    encoding: 'utf8'
  });
  console.log(`[verify] ${step} passed ✅`);
  if (output && output.trim()) {
    // Write success log too (useful for tester agent to read)
    const logDir = path.join(projectDir, '.team/verify-errors');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `latest-${step}.log`), output);
  }
  process.exit(0);
} catch (e) {
  const errorOutput = (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + (e.message || '');
  console.error(`[verify] ${step} failed ❌`);
  console.error(errorOutput.slice(0, 500));

  // Write error log for PM triage
  const logDir = path.join(projectDir, '.team/verify-errors');
  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `${timestamp}-${step}.log`);
  fs.writeFileSync(logFile, [
    `# Verify ${step} failed`,
    `Time: ${new Date().toISOString()}`,
    `Command: ${command}`,
    `Exit code: ${e.status || 'unknown'}`,
    '',
    '## Output',
    errorOutput
  ].join('\n'));

  // Also write latest error for easy access
  fs.writeFileSync(path.join(logDir, `latest-${step}.log`), errorOutput);

  console.error(`[verify] Error log: ${logFile}`);
  process.exit(1);
}
