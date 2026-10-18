// Development and tests only: Postgres compiled to WebAssembly, in memory or in a local folder.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { wrap } from '../lib/db.mjs';

const options = { parsers: { 1082: (v) => v } }; // DATE stays 'YYYY-MM-DD', as in production

export function pglite(dataDir) {
  if (!dataDir) return wrap(new PGlite(options));
  mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
  return wrap(new PGlite(dataDir, options));
}
