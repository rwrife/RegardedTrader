#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();
const scanRoots = ['packages/core/src', 'packages/server/src', 'packages/cli/src', 'packages/web/src'];
const allowedLiteralFiles = new Set(['packages/core/src/constants.ts']);

const sourceExt = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ignorePathPart = new Set(['dist', 'node_modules', '.git']);

function walk(absDir) {
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (ignorePathPart.has(entry.name)) continue;
      out.push(...walk(absPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!sourceExt.test(entry.name)) continue;
    if (/\.test\.|\.spec\./.test(entry.name)) continue;
    out.push(absPath);
  }
  return out;
}

function lineOf(content, idx) {
  return content.slice(0, idx).split('\n').length;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const hardcoded = [];
const literalRegex = /['"`][^'"`\n]*Not financial advice[^'"`\n]*['"`]/g;

for (const root of scanRoots) {
  const absRoot = join(repoRoot, root);
  if (!statSync(absRoot, { throwIfNoEntry: false })) continue;

  for (const absFile of walk(absRoot)) {
    const relFile = relative(repoRoot, absFile).replace(/\\/g, '/');
    if (allowedLiteralFiles.has(relFile)) continue;

    const src = readFileSync(absFile, 'utf8');
    const codeOnly = stripComments(src);
    let match;
    while ((match = literalRegex.exec(codeOnly)) !== null) {
      hardcoded.push({
        file: relFile,
        line: lineOf(codeOnly, match.index),
        snippet: match[0],
      });
    }
  }
}

if (hardcoded.length > 0) {
  console.error('Hardcoded disclaimer string(s) found outside canonical source:');
  for (const hit of hardcoded) {
    console.error(` - ${hit.file}:${hit.line}  ${hit.snippet}`);
  }
  console.error('\nUse DISCLAIMER from packages/core/src/constants.ts (or shared wrappers/components).');
  process.exit(1);
}

console.log('Disclaimer audit passed: no hardcoded "Not financial advice" literals outside canonical source.');
