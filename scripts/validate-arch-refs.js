#!/usr/bin/env node
/**
 * validate-arch-refs.js — Check that API references in ARCHITECTURE.md actually exist.
 * Exit 0 if all refs valid (or no ARCHITECTURE.md), exit 1 if invalid refs found.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let projectDir = process.cwd();
while (projectDir !== path.dirname(projectDir)) {
  if (fs.existsSync(path.join(projectDir, '.team/config.json'))) break;
  projectDir = path.dirname(projectDir);
}

const archPath = path.join(projectDir, 'ARCHITECTURE.md');
if (!fs.existsSync(archPath)) {
  console.log('[validate-refs] No ARCHITECTURE.md, skipping');
  process.exit(0);
}

const arch = fs.readFileSync(archPath, 'utf8');
const issues = [];

// Extract file path references (e.g., src/foo.swift, lib/bar.js)
const fileRefs = arch.match(/(?:src|lib|Sources|tests?|packages?)\/[\w\-\/]+\.\w+/gi) || [];
const uniqueRefs = [...new Set(fileRefs)];

for (const ref of uniqueRefs) {
  const fullPath = path.join(projectDir, ref);
  if (!fs.existsSync(fullPath)) {
    issues.push(`Missing file: ${ref}`);
  }
}

// Extract function references in code blocks (basic heuristic)
const codeBlocks = arch.match(/```[\s\S]*?```/g) || [];
for (const block of codeBlocks) {
  // Check for Swift func references
  const funcs = block.match(/(\w+)\.([\w]+)\(/g) || [];
  // Just log them for now — full validation would need AST parsing
}

if (issues.length === 0) {
  console.log(`[validate-refs] All ${uniqueRefs.length} file references valid ✅`);
  process.exit(0);
} else {
  console.error(`[validate-refs] ${issues.length} invalid references found ❌`);
  issues.forEach(i => console.error(`  - ${i}`));
  
  // Write issues for architect to read
  const issuesPath = path.join(projectDir, '.team/verify-errors/arch-refs.log');
  fs.mkdirSync(path.dirname(issuesPath), { recursive: true });
  fs.writeFileSync(issuesPath, issues.join('\n'));
  
  process.exit(1);
}
