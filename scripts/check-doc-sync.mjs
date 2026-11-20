#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const stagedOnly = args.has('--staged');

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function unique(items) {
  return [...new Set(items)];
}

function getChangedFiles() {
  const staged = git(['diff', '--cached', '--name-only']);
  if (stagedOnly) {
    return staged;
  }

  const unstaged = git(['diff', '--name-only']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return unique([...staged, ...unstaged, ...untracked]);
}

const rules = [
  {
    name: 'Browser MCP / browser actions / element targets',
    implementation: [
      /^content\/modules\/browser-actions\.js$/,
      /^content\/modules\/browser-action-dom\.js$/,
      /^content\/modules\/browser-console\.js$/,
      /^content\/modules\/screenshot\.js$/,
      /^content\/modules\/element-targets\.js$/,
      /^content\/modules\/element-saver\.js$/,
    ],
    docs: [
      'docs/HANDOFF.md',
      'docs/BROWSER_MCP_DESIGN.md',
      'docs/ARCHITECTURE.md',
      'docs/STATE_ANALYSIS.md',
    ],
  },
  {
    name: 'chat / session / persistence / SSE / Markdown / image',
    implementation: [
      /^content\/modules\/chat-/,
      /^content\/modules\/ws-client\.js$/,
      /^content\/modules\/markdown-/,
      /^content\/modules\/image-/,
      /^content\/modules\/screenshot\.js$/,
    ],
    docs: [
      'docs/HANDOFF.md',
      'docs/ARCHITECTURE.md',
      'docs/STATE_ANALYSIS.md',
    ],
  },
  {
    name: 'extension UI / Shadow DOM / selector / overlay',
    implementation: [
      /^content\/content-script\.js$/,
      /^content\/modules\/shadow-ui\.js$/,
      /^content\/modules\/selector-mode\.js$/,
      /^content\/modules\/visbug-hit-test\.js$/,
      /^popup\//,
      /^manifest\.json$/,
    ],
    docs: [
      'docs/ARCHITECTURE_DECISION.md',
      'docs/HANDOFF.md',
    ],
  },
];

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

const changedFiles = getChangedFiles();

if (changedFiles.length === 0) {
  console.log('[doc-sync] OK: no changed files.');
  process.exit(0);
}

const failures = [];

for (const rule of rules) {
  const implementationFiles = changedFiles.filter((file) =>
    matchesAny(file, rule.implementation),
  );

  if (implementationFiles.length === 0) {
    continue;
  }

  const changedDocs = changedFiles.filter((file) => rule.docs.includes(file));
  if (changedDocs.length === 0) {
    failures.push({
      rule,
      implementationFiles,
    });
  }
}

if (failures.length === 0) {
  console.log('[doc-sync] OK: guarded implementation changes have matching docs updates.');
  process.exit(0);
}

console.error('[doc-sync] Documentation sync check failed.');

for (const failure of failures) {
  console.error('');
  console.error(`Scope: ${failure.rule.name}`);
  console.error('Changed implementation files:');
  for (const file of failure.implementationFiles) {
    console.error(`  - ${file}`);
  }
  console.error('Update at least one of:');
  for (const file of failure.rule.docs) {
    console.error(`  - ${file}`);
  }
}

console.error('');
console.error('If docs are intentionally unchanged, mention the reason in the final handoff.');
process.exit(1);
