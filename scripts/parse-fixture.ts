#!/usr/bin/env tsx
// Local debugging tool for the ParseStage.
//
// Usage:
//   pnpm tsx scripts/parse-fixture.ts <fixture-name>
//   pnpm tsx scripts/parse-fixture.ts path/to/note.txt
//
// Without arguments, lists available fixtures.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClinicalNote } from '../lib/parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '..', 'lib', 'parse', '__fixtures__');

const RESET = '[0m';
const DIM = '[2m';
const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const CYAN = '[36m';

function colorConfidence(c: string): string {
  if (c === 'high') return `${GREEN}${c}${RESET}`;
  if (c === 'medium') return `${YELLOW}${c}${RESET}`;
  return `${RED}${c}${RESET}`;
}

function listFixtures(): string[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt'));
}

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.log(`${BOLD}Available fixtures:${RESET}`);
    for (const name of listFixtures()) {
      console.log(`  ${name}`);
    }
    console.log(`\nUsage: tsx scripts/parse-fixture.ts <fixture-name|path>`);
    process.exit(0);
  }

  let path = arg;
  if (!existsSync(path)) {
    const fixturePath = join(FIXTURE_DIR, arg);
    if (existsSync(fixturePath)) path = fixturePath;
    else {
      console.error(`${RED}Could not find fixture or file: ${arg}${RESET}`);
      process.exit(1);
    }
  }

  const raw = readFileSync(path, 'utf-8');
  console.log(`${DIM}Loaded ${raw.length.toLocaleString()} chars from ${path}${RESET}\n`);

  const parsed = await parseClinicalNote(raw);

  console.log(`${BOLD}Confidence:${RESET} ${colorConfidence(parsed.confidence)}`);
  console.log(`${BOLD}Sections found:${RESET} ${parsed.cleaningReport.sectionsFound}`);
  console.log(`${BOLD}Used LLM:${RESET} ${parsed.cleaningReport.usedLLM} (${parsed.cleaningReport.parserProvider})`);
  console.log(`${BOLD}Cleaning:${RESET} ${parsed.cleaningReport.charsStripped} chars stripped, ${parsed.cleaningReport.quotesFolded} quotes folded, ${parsed.cleaningReport.pageBreaksRemoved} page breaks`);
  console.log(`${BOLD}Latency:${RESET} ${parsed.cleaningReport.latencyMs} ms\n`);

  if (parsed.warnings.length > 0) {
    console.log(`${YELLOW}${BOLD}Warnings:${RESET}`);
    for (const w of parsed.warnings) console.log(`  ${YELLOW}• ${w}${RESET}`);
    console.log();
  }

  for (const [key, value] of Object.entries(parsed.sections)) {
    if (!value) continue;
    console.log(`${CYAN}${BOLD}### ${key}${RESET}`);
    console.log(`${value.trim()}\n`);
  }
}

main().catch((err) => {
  console.error(`${RED}${err instanceof Error ? err.stack : String(err)}${RESET}`);
  process.exit(1);
});
