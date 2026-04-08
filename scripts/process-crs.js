#!/usr/bin/env node
/**
 * Process pending Change Requests — batch merge into target files
 * 
 * Groups CRs by target file, appends proposed changes, marks as resolved.
 * For doc files (ARCHITECTURE.md, PRD.md) — auto-append.
 * For source files — creates a task for developer to handle.
 */
const fs = require('fs');
const path = require('path');

const dir = process.cwd();
const crDir = path.join(dir, '.team/change-requests');

if (!fs.existsSync(crDir)) {
  console.log('No change-requests directory');
  process.exit(0);
}

const files = fs.readdirSync(crDir).filter(f => f.endsWith('.json'));
const pending = [];

files.forEach(f => {
  try {
    const cr = JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8'));
    if (cr.status === 'pending') pending.push({ file: f, ...cr });
  } catch {}
});

if (pending.length === 0) {
  console.log('No pending CRs');
  process.exit(0);
}

console.log(`Processing ${pending.length} pending CRs...`);

// Group by target file
const byTarget = {};
pending.forEach(cr => {
  const target = cr.targetFile || 'unknown';
  if (!byTarget[target]) byTarget[target] = [];
  byTarget[target].push(cr);
});

const docFiles = ['ARCHITECTURE.md', 'PRD.md', 'VISION.md', 'README.md', 'EXPECTED_DBB.md'];

for (const [target, crs] of Object.entries(byTarget)) {
  const targetPath = path.join(dir, target);
  const isDoc = docFiles.includes(target);

  if (isDoc) {
    // Auto-append to doc files
    let content = '';
    try { content = fs.readFileSync(targetPath, 'utf8'); } catch {}

    let appended = 0;
    crs.forEach(cr => {
      const proposal = cr.proposedChange || '';
      if (!proposal) return;

      // Check if already present (avoid duplicates)
      const firstLine = proposal.split('\n')[0].trim();
      if (content.includes(firstLine)) {
        console.log(`  SKIP (already present): ${cr.file} — ${cr.reason?.slice(0, 60)}`);
        // Mark as resolved
        const crPath = path.join(crDir, cr.file);
        const data = JSON.parse(fs.readFileSync(crPath, 'utf8'));
        data.status = 'resolved';
        data.resolution = 'already present in target';
        data.reviewedAt = new Date().toISOString();
        data.reviewedBy = 'process-crs';
        fs.writeFileSync(crPath, JSON.stringify(data, null, 2));
        return;
      }

      content += '\n\n' + proposal;
      appended++;

      // Mark CR as resolved
      const crPath = path.join(crDir, cr.file);
      const data = JSON.parse(fs.readFileSync(crPath, 'utf8'));
      data.status = 'resolved';
      data.resolution = 'auto-merged by process-crs';
      data.reviewedAt = new Date().toISOString();
      data.reviewedBy = 'process-crs';
      fs.writeFileSync(crPath, JSON.stringify(data, null, 2));
    });

    if (appended > 0) {
      fs.writeFileSync(targetPath, content);
      console.log(`  ✅ ${target}: appended ${appended} changes`);
    }
  } else {
    // Source files — just mark as resolved with note
    crs.forEach(cr => {
      console.log(`  ⚠️ Source CR skipped: ${cr.file} → ${target} — ${cr.reason?.slice(0, 60)}`);
      const crPath = path.join(crDir, cr.file);
      const data = JSON.parse(fs.readFileSync(crPath, 'utf8'));
      data.status = 'deferred';
      data.resolution = 'source file CR — needs manual review';
      data.reviewedAt = new Date().toISOString();
      fs.writeFileSync(crPath, JSON.stringify(data, null, 2));
    });
  }
}

// Summary
const remaining = fs.readdirSync(crDir).filter(f => {
  try { return JSON.parse(fs.readFileSync(path.join(crDir, f), 'utf8')).status === 'pending'; }
  catch { return false; }
}).length;

console.log(`\nDone. Remaining pending: ${remaining}`);
