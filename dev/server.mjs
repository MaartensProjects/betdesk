// Local development: the same fetch handler on http://localhost:3000, with Postgres from DATABASE_URL or, when it is
// not set, PGlite in .data/pglite. Reads .env.local if present. DEV_LOGIN_EMAIL enables /dev/login (localhost only).
import http from 'node:http';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createApp } from '../lib/app.mjs';
import { loadConfig } from '../lib/config.mjs';
import { poolFromUrl } from '../lib/db.mjs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const port = Number(process.env.PORT || 3000);
process.env.APP_URL ||= `http://localhost:${port}`;
process.env.DATABASE_URL ||= 'pglite:.data/pglite';
process.env.SESSION_SECRET ||= 'dev-only-secret-dev-only-secret-dev-only';
const cfg = loadConfig();

async function getDb() {
  if (cfg.databaseUrl.startsWith('pglite:')) {
    const { pglite } = await import('./pglite.mjs');
    return pglite(cfg.databaseUrl.slice('pglite:'.length));
  }
  return poolFromUrl(cfg.databaseUrl);
}

const app = createApp({ cfg, getDb, devLogin: process.env.DEV_LOGIN_EMAIL || '' });

http
  .createServer(async (req, res) => {
    const url = `http://localhost:${port}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await app.fetch(request);
    const headers = {};
    response.headers.forEach((v, k) => {
      if (k === 'set-cookie') return;
      headers[k] = v;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (!response.body) return res.end();
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  })
  .listen(port, '127.0.0.1', () => console.log(`${cfg.appName} on http://localhost:${port}${process.env.DEV_LOGIN_EMAIL ? ` · sign in at /dev/login as ${process.env.DEV_LOGIN_EMAIL}` : ''}`));
