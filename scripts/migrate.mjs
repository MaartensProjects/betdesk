// Applies the database migrations to DATABASE_URL. The app also does this on its first request; this script is for
// installs that want the tables before the first visit:  vercel env run -e production -- npm run migrate
import { loadConfig } from '../lib/config.mjs';
import { poolFromUrl, migrate } from '../lib/db.mjs';

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const db = await poolFromUrl(cfg.databaseUrl);
await migrate(db);
console.log('migrations applied');
await db.close();
