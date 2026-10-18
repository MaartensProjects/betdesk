// Reads the configuration from environment variables. Pure: tests pass their own env object.
// Secrets live in the host's environment settings (Vercel project settings), never in the repository.

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

export function loadConfig(env = process.env) {
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
  const appUrl = trimSlash(env.APP_URL || vercelUrl || 'http://localhost:3000');
  const jiraBase = trimSlash(env.JIRA_BASE_URL);
  return {
    appName: env.APP_NAME || 'Betdesk',
    appUrl,
    secure: appUrl.startsWith('https://'),
    timeZone: env.TIME_ZONE || 'UTC',
    sessionSecret: env.SESSION_SECRET || '',
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    },
    access: {
      domains: list(env.ALLOWED_DOMAINS),
      emails: list(env.ALLOWED_EMAILS),
      admins: list(env.ADMIN_EMAILS),
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    jira: {
      baseUrl: jiraBase,
      siteUrl: trimSlash(env.JIRA_SITE_URL) || jiraBase,
      email: env.JIRA_EMAIL || '',
      token: env.JIRA_API_TOKEN || '',
    },
    github: {
      token: env.GITHUB_TOKEN || '',
      label: env.GITHUB_AGENT_LABEL || 'betdesk-agent',
      apiUrl: trimSlash(env.GITHUB_API_URL) || 'https://api.github.com',
    },
    cronSecret: env.CRON_SECRET || '',
    // A turn stops starting new Claude calls when fewer seconds than this remain before the function's deadline.
    turnReserveSeconds: Number(env.TURN_RESERVE_SECONDS || 75),
    // Used when the platform gives no deadline (local dev): the length of one turn.
    turnSeconds: Number(env.TURN_SECONDS || 280),
    // A turn still marked running after this many seconds was cut off by the platform (maxDuration 300 + margin).
    staleSeconds: Number(env.TURN_STALE_SECONDS || 330),
  };
}

export const jiraConfigured = (cfg) => Boolean(cfg.jira.baseUrl && cfg.jira.email && cfg.jira.token);
export const githubConfigured = (cfg) => Boolean(cfg.github.token);

// Everything the app needs before anyone can sign in. Each problem names the variable to set.
export function configProblems(cfg) {
  const p = [];
  if (!cfg.databaseUrl) p.push('DATABASE_URL is not set: connect a Postgres database (for example Neon from the Vercel Marketplace).');
  if (cfg.sessionSecret.length < 32) p.push('SESSION_SECRET must be at least 32 random characters (openssl rand -hex 32).');
  if (!cfg.google.clientId || !cfg.google.clientSecret) p.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set: create an OAuth client in Google Cloud.');
  if (!cfg.access.domains.length && !cfg.access.emails.length && !cfg.access.admins.length) p.push('Nobody may sign in: set ALLOWED_DOMAINS (your Google Workspace domain) and/or ALLOWED_EMAILS, and ADMIN_EMAILS.');
  if (!cfg.anthropicApiKey) p.push('ANTHROPIC_API_KEY is not set: conversations with Claude cannot start.');
  return p;
}
