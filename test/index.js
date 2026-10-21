// Test bootstrap.
//
// Node >= 21 treats positional `--test` arguments as GLOB PATTERNS, so
// `node --test test/` matches the DIRECTORY `test` itself and executes it as a
// single entry (`node <dir>`, resolved here as index.js). This file therefore
// loads every *.test.js in this directory so the mandated command stays green.
//
// In all other contexts (bare `node --test`, explicit file globs, Node 20
// directory search) each *.test.js runs on its own and this file is either not
// executed or intentionally inert — no test ever runs twice.

import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const invokedDirectly = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
);

if (!invokedDirectly) {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(here)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const f of files) {
    await import(pathToFileURL(resolve(here, f)).href);
  }
}
