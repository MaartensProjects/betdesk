# Architecture

One Node.js function on Vercel, server-rendered pages, Postgres, no framework. Every page works without JavaScript; `public/app.js` adds streaming and Enter-to-send.

## Request flow

```
browser ──> Vercel CDN ── public/* (style.css, app.js, md.mjs, icons)
               │
               └─ every other path ── rewrite /api?route=<path> ──> api/index.mjs ──> lib/app.mjs (fetch handler)
                                                                                        │
                    Google (OIDC) <── lib/auth.mjs ─────────────────────────────────────┤
                    Postgres      <── lib/store.mjs ────────────────────────────────────┤
                    Claude API    <── lib/interview.mjs (Messages API, streaming) ──────┤
                    GitHub, Jira  <── lib/handoff.mjs, lib/github.mjs, lib/jira.mjs ─────┘
```

`dev/server.mjs` runs the same handler on a local port, with PGlite (Postgres in WebAssembly) when `DATABASE_URL` is not set.

## Modules

| File | Role |
|---|---|
| `lib/app.mjs` | Routes, sign-in gate, CSRF and origin checks, security headers, the streaming turn endpoint |
| `lib/auth.mjs` | Google sign-in (authorization code with PKCE, state and nonce; ID token verified against Google's keys), HMAC-signed session cookies, CSRF tokens, who may sign in |
| `lib/store.mjs` | All SQL. Conversation queries always take the user id; there is no query that reads a conversation by id alone |
| `lib/schema.mjs`, `lib/db.mjs` | Migrations (idempotent, under an advisory lock) and the pg/PGlite wrapper |
| `lib/cards.mjs` | The card schema and every rule of docs/ladder.md; pure functions |
| `lib/interview.mjs`, `lib/prompt.mjs` | One conversation turn: the tool loop, the tools, the interviewer's instructions |
| `lib/handoff.mjs` | Routing (agent or Jira), handoff, status sync |
| `lib/attention.mjs` | What needs whom on each card, and the button that resolves it |
| `lib/render.mjs` | A card as markdown (Claude, GitHub issues) and as Atlassian Document Format (Jira) |
| `views/*.mjs` | Server-rendered pages |

## Data

| Table | Holds |
|---|---|
| `users` | Email, Workspace domain, name, role, disabled |
| `cards` | Number (BD-n), owner, status, system, route, the card body and ladder (JSONB), dates, a version for optimistic locking |
| `card_events` | The evidence log and audit trail: every change with its source ("typed by Ann", "Claude in Ann's conversation", "status check") |
| `conversations`, `messages` | Private conversations; messages hold the API content blocks exactly as sent and received |
| `handoffs` | Each handoff attempt: route, target, issue or ticket key, URL, state, pull request, error |
| `settings` | Model, effort, web search, handoff mode, limits, systems |

Card statuses: `inbox`, `in validation`, `ready for dev`, `in dev`, `done`, `parked`, `killed`.

## A conversation turn

A turn runs inside one function invocation of at most 300 seconds:

1. The person's message (or their answers to Claude's question, sent back as the `ask_user` tool result) is stored. Once a day, a `<context>` block with the date, the person, the systems and the settings is added to it; the page never shows it.
2. The app calls `client.beta.messages.stream()` with the conversation's model, `thinking: {type: "adaptive"}`, `output_config.effort`, the static system prompt (`lib/prompt.mjs`, prompt-cached), automatic prompt caching for the history, and the tools. Text deltas stream to the browser as lines of JSON.
3. Tool calls run on the server: `search_cards`, `read_card`, `save_bet_card`, `record_test_result` and `close_card` go through the same rules as the card page. Card text comes back inside `<card_data>` tags. The three write tools act only on the person's own cards and never write from Claude's call: the server checks the change (errors go straight back to Claude), then ends the turn with a confirmation that shows exactly what would be written; the write runs on the person's Confirm, only if the card's version is still the one the proposal was made against, and its outcome is the tool result Claude sees next. Every question and confirmation form carries the id of what it shows, and the server refuses a mismatch. `ask_user` ends the turn and shows the questions as tappable options. One question batch or one change per response. With web search on, the server-side `web_search` tool is added. A tool that throws becomes an error result for Claude.
4. The loop ends when Claude ends its turn, asks a question, or fewer than `TURN_RESERVE_SECONDS` remain before the function's deadline (read with `getDeadline()` from `@vercel/functions`). A call still running 10 seconds before the deadline is aborted, without storing its partial answer. The page then offers Continue.

Robustness: the history is append-only (thinking blocks are sent back unchanged); a turn that was cut off is detected (its claim is older than `TURN_STALE_SECONDS`, 330 by default, just over the 300-second limit) and repaired by answering the orphaned tool calls; Continue refuses to send a history that ends with Claude's own finished answer. If the browser disconnects, the function finishes the turn and saves it (`waitUntil`). Client tools use `eager_input_streaming`, and every tool input is validated with zod before it runs. For `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5` and `claude-fable-5-1`, requests carry the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): if the model declines a request, the API retries it on a fallback model, billed at that model's rates, and the page notes it.

## Handoff

When the last rung before the build passes (from the card page or from a conversation), `afterReady` either waits for an admin (approval mode) or calls `handOff`:

- **Coding agent**: a GitHub issue in the system's repository with the spec (`specMarkdown`) and the label `betdesk-agent`. The workflow in `templates/github/betdesk-agent.yml` runs the Claude Code GitHub Action, which opens a pull request that closes the issue.
- **Jira**: an issue in the system's project, with the spec as Atlassian Document Format and the labels `betdesk` and `bd-<n>`.

The card is claimed by moving it to `in dev` with a version check before anything is created, so two clicks never make two tickets. Before creating, the handoff looks for an issue an earlier attempt made (a hidden card marker in GitHub issue bodies; the `bd-<n>` label in Jira) and reuses it. A definite rejection (a 4xx answer) moves the card back and records the error; a timeout or server error leaves the handoff `unknown`, and the status check finds the issue or, after two minutes, marks it failed. `syncHandoff` reads the issue and the agent's own pull requests (same repository, branch `betdesk/issue-<n>`) or the Jira status category: a merged pull request, an issue closed as completed, or a done ticket finishes the card; an agent issue closed otherwise sends it back to ready for dev. Every update is conditional on the state the check started from, so concurrent checks log a transition once. The daily cron (`/cron/sync`, `CRON_SECRET`), the board (when the oldest open check is older than 10 minutes) and the card's Check now button run it.

## Tests

`npm test` runs every module against PGlite with a scripted Claude (`test/helpers.mjs`) and fake GitHub, Jira and Google endpoints: the card rules, sign-in and redirects, privacy between people, CSRF, the turn loop (questions, confirmations, planted card text, tool errors, handoff from a conversation, time budget, deadline abort, repair), handoff routing, duplicate prevention and status sync, the turn cap, and the pages end to end through the fetch handler. The GitHub workflow template is not exercised by the tests; the smoke test in INSTALL.md step 9 covers it on a real repository.
