#!/usr/bin/env node
// Minimal test runner. No dependencies — this package ships none, deliberately.
//
// Usage: node scripts/run-tests.mjs [filter]

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const filter = process.argv[2];

const suites = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

process.stdout.write(`\n${suites.length} suite(s)${filter ? ` matching "${filter}"` : ''}\n\n`);

for (const file of suites) {
  const tests = [];
  const assert = {
    ok: (value, message) => {
      if (!value) throw new Error(message || 'expected a truthy value');
    },
    equal: (actual, expected, message) => {
      if (actual !== expected) throw new Error(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    deepEqual: (actual, expected, message) => {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(message || `expected ${b}, got ${a}`);
    },
    match: (value, re, message) => {
      if (!re.test(String(value))) throw new Error(message || `${JSON.stringify(String(value).slice(0, 80))} does not match ${re}`);
    },
    throws: (fn, message) => {
      try {
        fn();
      } catch {
        return;
      }
      throw new Error(message || 'expected a throw');
    },
  };

  const test = async (name, fn) => tests.push({ name, fn });

  try {
    const mod = await import(pathToFileURL(join(ROOT, 'test', file)).href);
    await mod.default({ test, assert });
  } catch (error) {
    failed += 1;
    failures.push({ suite: file, name: '<load>', message: error.message });
    process.stdout.write(`  FAIL  ${file} (<load>)\n        ${error.message}\n`);
    continue;
  }

  let suiteFailed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`  PASS  ${file} :: ${name}\n`);
    } catch (error) {
      suiteFailed += 1;
      failed += 1;
      failures.push({ suite: file, name, message: error.message });
      process.stdout.write(`  FAIL  ${file} :: ${name}\n        ${error.message}\n`);
    }
  }
  if (!suiteFailed) process.stdout.write(`        ${tests.length} passed\n`);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
if (failures.length) {
  process.stdout.write('failures:\n');
  for (const f of failures) process.stdout.write(`  ${f.suite} :: ${f.name}\n    ${f.message}\n`);
  process.stdout.write('\n');
}
process.exit(failed ? 1 : 0);