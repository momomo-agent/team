#!/usr/bin/env node
/**
 * scan-deps.js — Scan project dependencies and extract real API signatures.
 * Writes .team/deps-api.md for architect to reference.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let projectDir = process.cwd();
while (projectDir !== path.dirname(projectDir)) {
  if (fs.existsSync(path.join(projectDir, '.team/config.json'))) break;
  projectDir = path.dirname(projectDir);
}

const output = [];

// Swift / SPM
const packageSwift = path.join(projectDir, 'Package.swift');
if (fs.existsSync(packageSwift)) {
  output.push('# Dependency API Signatures (Swift)\n');
  
  // Check .build/checkouts for resolved deps
  const checkouts = path.join(projectDir, '.build/checkouts');
  if (fs.existsSync(checkouts)) {
    const deps = fs.readdirSync(checkouts).filter(d => 
      fs.statSync(path.join(checkouts, d)).isDirectory()
    );
    for (const dep of deps) {
      output.push(`## ${dep}\n`);
      try {
        const sigs = execSync(
          `grep -rn "public func\\|public class\\|public struct\\|public protocol\\|public enum\\|public var\\|public let" "${path.join(checkouts, dep)}/Sources/" 2>/dev/null | head -50`,
          { encoding: 'utf8', timeout: 10000 }
        );
        output.push('```swift\n' + (sigs || '(no public API found)') + '\n```\n');
      } catch {
        output.push('(could not scan)\n');
      }
    }
  } else {
    output.push('⚠️ .build/checkouts not found. Run `swift package resolve` first.\n');
  }
}

// Node.js
const packageJson = path.join(projectDir, 'package.json');
if (fs.existsSync(packageJson)) {
  output.push('# Dependency API Signatures (Node.js)\n');
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    for (const dep of deps.slice(0, 10)) {
      const depDir = path.join(projectDir, 'node_modules', dep);
      if (fs.existsSync(depDir)) {
        output.push(`## ${dep}\n`);
        const mainFile = path.join(depDir, 'index.js');
        const dts = path.join(depDir, 'index.d.ts');
        if (fs.existsSync(dts)) {
          try {
            const sigs = execSync(
              `grep -n "export " "${dts}" | head -30`,
              { encoding: 'utf8', timeout: 5000 }
            );
            output.push('```typescript\n' + sigs + '\n```\n');
          } catch { output.push('(could not scan .d.ts)\n'); }
        } else {
          output.push(`(no .d.ts, check ${dep} docs)\n`);
        }
      }
    }
  } catch {}
}

if (output.length === 0) {
  output.push('# No dependencies detected\n');
}

const depsPath = path.join(projectDir, '.team/deps-api.md');
fs.writeFileSync(depsPath, output.join('\n'));
console.log(`[scan-deps] Wrote ${depsPath} (${output.length} sections)`);
