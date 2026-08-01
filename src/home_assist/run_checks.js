#!/usr/bin/env node
'use strict';
/**
 * run_checks.js — `node --check` every server-side .js in the repo.
 *
 *   npm run home_assist_check
 *
 * A 200ms syntax gate. Catches the class of mistake that would otherwise only surface when pm2
 * restarts the collector at 2am and it immediately dies.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'web']);   // web/ is ESM+JSX, checked by vite

function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(REPO).sort();
let bad = 0;
files.forEach(function (f) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    console.error('FAIL  ' + path.relative(REPO, f));
    console.error(r.stderr.trim().split('\n').slice(0, 4).map(function (l) { return '      ' + l; }).join('\n'));
  }
});

console.log((files.length - bad) + '/' + files.length + ' files parse cleanly.');
process.exit(bad ? 1 : 0);
