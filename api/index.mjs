// The Vercel Function: every path is rewritten here (vercel.json). Static files in public/ are served first by Vercel.
import { waitUntil, getDeadline } from '@vercel/functions';
import { createApp } from '../lib/app.mjs';
import { loadConfig } from '../lib/config.mjs';
import { poolFromUrl } from '../lib/db.mjs';

const cfg = loadConfig();
const app = createApp({ cfg, getDb: () => poolFromUrl(cfg.databaseUrl), waitUntil, deadline: getDeadline });

export default {
  fetch: (request) => app.fetch(request),
};
