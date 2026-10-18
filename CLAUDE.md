# Betdesk

Bet cards for a webshop team: private Claude interviews turn ideas into tested bets; when every rung before the build passes, the card goes to a coding agent (GitHub issue + Claude Code GitHub Action) or to Jira. Read docs/ladder.md (the method and its rules), docs/architecture.md (modules, data, a turn, the handoff) and docs/security.md before changing behaviour.

- Node 22+, ES modules, no framework, no build step. One fetch handler (lib/app.mjs) runs as the Vercel function (api/index.mjs) and in dev/server.mjs.
- Tests: `npm ci --include=dev && npm test` (PGlite in memory, scripted Claude in test/helpers.mjs, fake GitHub/Jira/Google). Every behaviour change comes with a test; keep them all passing.
- Conversations are private: every conversation query in lib/store.mjs takes the user id. Never add one that does not.
- The card rules live in lib/cards.mjs and apply to the card page and to Claude's tools alike. Do not weaken them in one path only. Claude's write tools only propose; the write runs on the person's Confirm (lib/interview.mjs proposeWrite). Keep it that way.
- Never edit a migration in lib/schema.mjs once it is published; add a new one (idempotent: IF NOT EXISTS).
- Claude API: lib/interview.mjs and lib/prompt.mjs. History is append-only; the system prompt is static (cached); variable context goes in the <context> block.
- Secrets only in environment variables; never commit an env file with values. Update the docs with every change.
