#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const schemaPath = join(repoRoot, 'packages/core/src/schemas/recommendation.ts');
const glossaryPath = join(repoRoot, 'docs/domain-glossary.md');

const schema = readFileSync(schemaPath, 'utf8');
const glossary = readFileSync(glossaryPath, 'utf8');

const enumMatch = schema.match(/export const RecommendationKind = z\.enum\(\[(.*?)\]\);/s);
if (!enumMatch) {
  console.error('Could not locate RecommendationKind enum in recommendation schema.');
  process.exit(1);
}

const values = Array.from(enumMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
if (values.length === 0) {
  console.error('RecommendationKind enum appears empty; aborting glossary check.');
  process.exit(1);
}

const missing = values.filter((value) => !glossary.includes(`\`${value}\``));
if (missing.length > 0) {
  console.error('docs/domain-glossary.md is missing RecommendationKind entries:');
  for (const value of missing) {
    console.error(` - ${value}`);
  }
  process.exit(1);
}

console.log(
  `Domain glossary check passed: found ${values.length} RecommendationKind entries in docs/domain-glossary.md.`,
);
