// Lists which settings are present, by name only. Never prints a value.
//   vercel env run -e production -- npm run check-env
import { loadConfig, configProblems, jiraConfigured, githubConfigured } from '../lib/config.mjs';

const cfg = loadConfig();
const problems = configProblems(cfg);
console.log(`APP_URL: ${cfg.appUrl}`);
console.log(`sign-in: ${cfg.access.domains.length} domain(s), ${cfg.access.emails.length} extra address(es), ${cfg.access.admins.length} admin(s)`);
console.log(`Jira: ${jiraConfigured(cfg) ? 'configured' : 'not configured'} · coding agent token: ${githubConfigured(cfg) ? 'set' : 'not set'} · CRON_SECRET: ${cfg.cronSecret ? 'set' : 'not set'}`);
if (problems.length) {
  console.log('\nTo fix:');
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log('\nRequired settings are present.');
