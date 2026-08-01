#!/usr/bin/env node
'use strict';
/**
 * run_tests.js — run every *.test.js under src/home_assist with node's built-in test runner.
 *
 *   npm run home_assist_test              # everything
 *   npm run home_assist_test modules/water  # only that subtree
 *
 * None of these tests touch MySQL, the network, or a radio: they are meant to run in a second, on
 * any machine, so there is no excuse not to run them before a deploy.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const filter = process.argv[2] || '';

function find_tests(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) find_tests(full, out);
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

let files = find_tests(ROOT).sort();
if (filter) {
  const needle = filter.split(path.sep).join('/');
  files = files.filter(function (f) { return f.split(path.sep).join('/').includes(needle); });
}

if (!files.length) {
  console.error('No test files found' + (filter ? ' matching "' + filter + '"' : '') + '.');
  process.exit(1);
}

console.log('Running ' + files.length + ' test file(s):');
files.forEach(function (f) { console.log('  ' + path.relative(ROOT, f).split(path.sep).join('/')); });
console.log('');

const r = spawnSync(process.execPath, ['--test'].concat(files), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
