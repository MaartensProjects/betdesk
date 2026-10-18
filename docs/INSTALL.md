# Installing Betdesk on Vercel

These instructions are written for an AI agent (for example Claude Code) that installs Betdesk for a company, working with one person from that company: **the operator**. Steps marked **OPERATOR** need that person in a browser console or for a decision; everything else the agent does itself. A human can follow them just as well.

## Rules for the installing agent

1. **Secrets never pass through you.** Never ask the operator to paste a secret into the chat, and never print, log, echo or commit one. Secrets reach Vercel in one of two ways: the operator types them into the Vercel dashboard, or runs `vercel env add NAME production` themselves and types the value at the prompt; or you generate a random value and pipe it straight into `vercel env add` without displaying it (SESSION_SECRET and CRON_SECRET only). The secrets are `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `JIRA_API_TOKEN`, `GITHUB_TOKEN`, `SESSION_SECRET`, `CRON_SECRET` and the database URL.
2. **Money and data-location choices belong to the operator.** The Vercel plan, the database plan and region, the Claude model and effort, web search, and the coding agent's model all cost money or decide where data lives. Present the options with their consequences and a link to the live price page, and recommend no default. Wait for the answer.
3. **Stop at every OPERATOR step** and wait until the operator says it is done. Verify what you can afterwards (step 8 has the checks).
4. Do not modify the application code during installation. Configuration goes into environment variables and the in-app Settings page.

## What gets installed

| Part | Where | Purpose |
|---|---|---|
| The app | One Vercel project: a single Node.js function (`api/index.mjs`) plus static files in `public/` | Board, private conversations with Claude, bet cards, settings |
| Database | Postgres, for example Neon from the Vercel Marketplace | Users, cards, conversations, handoffs, settings |
| Sign-in | A Google OAuth client | Google sign-in, limited to the company's Workspace domain and listed addresses |
| Claude | An Anthropic API key | The interviews (Messages API) |
| Jira (optional) | A Jira Cloud API token of a service account | Tickets for cards that a developer builds |
| Coding agent (optional) | A GitHub token, plus a workflow in each target repository | GitHub issues that the Claude Code GitHub Action turns into pull requests |
| Daily status check | A Vercel cron job (`vercel.json`) | Follows open tickets and pull requests; the board also checks them when it is opened |

Requirements on the machine you work from: Node.js 22 or later, git, the Vercel CLI (`npm i -g vercel`, then `vercel login`), and optionally the GitHub CLI (`gh`).

## Step 0. Decide with the operator (OPERATOR)

Ask these in one batch:

1. **Vercel team and plan.** Which Vercel team the project goes in. Vercel's Hobby plan is for personal, non-commercial use, so a company normally needs Pro. Functions run up to 300 seconds on every plan, which Betdesk needs for one Claude turn. Hobby limits cron jobs to once a day, which is all Betdesk uses. Prices: https://vercel.com/pricing.
2. **Where the data lives.** Conversations can contain business plans. Choose the Vercel function region and the database region together, for example `fra1` with a Frankfurt database for the EU, or the default `iad1` with a US East database. If the operator picks a region other than `iad1`, add `"regions": ["<region>"]` to `vercel.json`. Anthropic's API processes the conversations too; point the operator to Anthropic's commercial terms and data retention settings if that matters to them.
3. **The address.** A custom domain, such as `betdesk.example.com`, or the project's `*.vercel.app` production URL. This becomes `APP_URL`. Google sign-in only works on this one address, so preview deployments cannot sign in.
4. **Who may sign in.** The Google Workspace domain or domains (`ALLOWED_DOMAINS`), extra individual addresses such as contractors (`ALLOWED_EMAILS`), and the admins (`ADMIN_EMAILS`), who see Settings and can hand cards off.
5. **App name and time zone.** For example `Betdesk` and an IANA time zone such as `Europe/London` or `America/New_York`. The time zone decides what "today" means for test dates.
6. **Integrations now or later.** Jira (yes or no; if yes, the site URL and which projects) and the coding agent (yes or no; if yes, which repositories). Both can be added later.

## Step 1. Get the code

Make the company's own copy, so its configuration and any later changes stay in its own account:

```bash
git clone https://github.com/MaartensProjects/betdesk.git
cd betdesk
gh repo create <org>/betdesk --private --source . --push   # or push to any git host Vercel can read
npm ci --include=dev
npm test
```

All tests must pass. They run against PGlite, an in-memory Postgres, with a scripted Claude, so they need no keys.

## Step 2. Create the Vercel project

```bash
vercel link            # create a new project in the chosen team; framework preset "Other", no build command
```

`vercel.json` already configures the function (300 seconds), the route rewrite and the daily cron. To deploy on every push, connect the git repository in the Vercel dashboard (Project, Settings, Git).

## Step 3. Database

Add Postgres from the Vercel Marketplace. With Neon:

```bash
vercel integration add neon -e production
```

The CLI asks the operator to accept the provider's terms and to choose a plan and a region (**OPERATOR**: plan and region, as decided in step 0). It connects the database and sets `DATABASE_URL` on the project. Any Postgres 15 or later works: set `DATABASE_URL` (or `POSTGRES_URL`) by hand. Betdesk creates its tables on the first request.

## Step 4. Google sign-in (OPERATOR)

In the Google Cloud Console (https://console.cloud.google.com), in a project that belongs to the company's Google Workspace organisation:

1. **Google Auth Platform, Branding / Audience:** set the user type to **Internal**. This limits sign-in to the organisation's own accounts, on top of Betdesk's own check. App name: the app name from step 0. Scopes: `openid`, `email`, `profile` only.
2. **Clients, Create client:** application type **Web application**. Authorised redirect URI: `<APP_URL>/auth/callback`, for example `https://betdesk.example.com/auth/callback`. Add `http://localhost:3000/auth/callback` only if people will run it locally.
3. Note the **Client ID**, which is not secret: tell it to the agent. The operator puts the **Client secret** into Vercel as `GOOGLE_CLIENT_SECRET` (step 5).

If the company is not on Google Workspace, use an External app in testing or production status and list every person in `ALLOWED_EMAILS`. The domain check uses Google's `hd` claim, which only Workspace accounts carry.

## Step 5. Environment variables

Set everything for the **Production** environment. You set the values that are not secret:

```bash
vercel env add APP_URL production --value "https://betdesk.example.com" --no-sensitive --yes
vercel env add APP_NAME production --value "Betdesk" --no-sensitive --yes
vercel env add TIME_ZONE production --value "Europe/London" --no-sensitive --yes
vercel env add ALLOWED_DOMAINS production --value "example.com" --no-sensitive --yes
vercel env add ALLOWED_EMAILS production --value "contractor@gmail.com" --no-sensitive --yes   # only if there are any
vercel env add ADMIN_EMAILS production --value "po@example.com,cto@example.com" --no-sensitive --yes
vercel env add GOOGLE_CLIENT_ID production --value "<client id>" --no-sensitive --yes
# Jira, if chosen:
vercel env add JIRA_BASE_URL production --value "https://example.atlassian.net" --no-sensitive --yes
vercel env add JIRA_EMAIL production --value "betdesk-bot@example.com" --no-sensitive --yes
```

You generate two secrets without ever displaying them:

```bash
openssl rand -hex 32 | vercel env add SESSION_SECRET production --sensitive
openssl rand -hex 32 | vercel env add CRON_SECRET production --sensitive
```

The **OPERATOR** adds the remaining secrets, in the Vercel dashboard (Project, Settings, Environment Variables, marked Sensitive) or with `vercel env add <NAME> production` in their own terminal:

| Variable | Where the operator gets it |
|---|---|
| `GOOGLE_CLIENT_SECRET` | Step 4 |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com, API keys. A dedicated workspace with a monthly spend limit keeps Betdesk's cost visible and capped. |
| `JIRA_API_TOKEN` (if Jira) | https://id.atlassian.com/manage-profile/security/api-tokens, created **as the service account** in `JIRA_EMAIL`. That account needs "Browse projects" and "Create issues" in each Jira project Betdesk sends to. |
| `GITHUB_TOKEN` (if coding agent) | A fine-grained personal access token of a bot or service account (https://github.com/settings/personal-access-tokens), limited to the target repositories, with **Issues: read and write**, **Pull requests: read** and **Metadata: read**. The account needs write access to those repositories, because the agent workflow only runs for labels set by people with write access. A GitHub App installation token works too (see step 7). |

Optional variables:

| Variable | Default | Meaning |
|---|---|---|
| `JIRA_SITE_URL` | `JIRA_BASE_URL` | Set when `JIRA_BASE_URL` is the `https://api.atlassian.com/ex/jira/<cloudId>` address of a scoped API token; browse links then still use the site. |
| `GITHUB_AGENT_LABEL` | `betdesk-agent` | The label that starts the agent workflow. Change it in the workflow too. |
| `GITHUB_API_URL` | `https://api.github.com` | For GitHub Enterprise Server. |
| `TURN_RESERVE_SECONDS` | `75` | A turn stops starting new Claude calls when fewer seconds than this remain before the function's 300-second limit; the person taps Continue. |

Check the list with `vercel env ls production`. It shows names, not secret values.

## Step 6. Deploy

```bash
vercel deploy --prod
curl -s https://<APP_URL>/healthz        # {"ok":true}: database reachable, tables created
```

If the operator chose a custom domain, add it in the Vercel dashboard (Project, Settings, Domains) and follow the DNS instructions there.

## Step 7. Coding agent in each target repository (optional)

For every repository that a Betdesk system will hand cards to:

1. **OPERATOR, required:** protect the default branch with a ruleset (Settings, Rules, Rulesets): require a pull request with at least one approving review before merging, and block force pushes. The agent works from text that any signed-in person can write, so this rule is what guarantees that nothing reaches the default branch without a developer. Do not let GitHub Actions bypass the ruleset.
2. Copy `templates/github/betdesk-agent.yml` to `.github/workflows/betdesk-agent.yml` in that repository, through a pull request that a developer of that repository reviews and merges. The workflow has two jobs. In `implement`, the Claude Code GitHub Action (`anthropics/claude-code-action@v1`) works with a read-only token and no stored git credentials: it reads and edits files and commits locally, runs no other commands, and cannot push, comment or open anything. The workflow never builds or tests the repository's code: that runs in the repository's own CI on the pull request, in the pull request's scope. In `publish`, which has no agent, the commits are pushed to `betdesk/issue-<n>` and a pull request that closes the issue is opened or updated; changes under `.github/` or `.claude/` are refused; or the agent's questions are posted on the issue. A failed run says so on the issue.
3. **OPERATOR**, in that repository's Settings, Secrets and variables, Actions:
   - Secret `ANTHROPIC_API_KEY`: the key the agent's runs are billed to. It may be the same as Betdesk's or a separate one.
   - Variable `BETDESK_AGENT_MODEL` (required): the model the agent runs on. This is a cost decision for the operator.
   - Variable `BETDESK_SENDER` (required): the GitHub login of the account behind Betdesk's `GITHUB_TOKEN`. Only labels set by that account start the agent; without it, the workflow refuses to run.
   - Variable `BETDESK_ALLOWED_BOTS`: only when Betdesk uses a GitHub App token, the app's bot login (for example `betdesk[bot]`).
4. The repository's own `CLAUDE.md` or `AGENTS.md`, if present, guides the agent. The agent cannot run the tests itself. Letting it run commands (adding to `--allowedTools`) makes it better at fixing failing tests, but then code it edited runs in the job that holds its Anthropic key, in the default branch's scope; on GitHub-hosted runners such code can read the job's secrets. Do not do that unless the repository accepts that risk.

A pull request that the workflow opens with its own `GITHUB_TOKEN` does not start other workflows, so CI will not run on it automatically. If the repository needs CI on the agent's pull requests, use a GitHub App or bot token for the push and `GH_TOKEN` in the publish job (comment in the workflow).

## Step 8. First sign-in and Settings (OPERATOR, with the agent)

1. An admin opens `<APP_URL>`, signs in with Google and lands on the board. It shows warnings with a Settings button for whatever is missing.
2. **Settings, Claude:** choose the model and the effort. The page lists the models the API key can use. This is the main cost decision: present the options with prices from https://www.anthropic.com/pricing and let the operator choose. For orientation only, Anthropic listed these prices on 2026-10-06, in dollars per million input and output tokens: Claude Opus 5.5 $4 / $20, Claude Sonnet 5.5 $2 / $10, Claude Haiku 5.5 $0.10 / $0.50. Check the live page. Optional: web search (billed per search on top of tokens) and a cap on turns per person per day.
3. **Settings, Handoff:** automatic (a card goes out as soon as every rung before the build has passed) or admin approval. Optionally, a limit on cards in validation per person.
4. **Settings, Systems:** one entry per system the webshop runs on, such as the storefront, ERP, PIM, payments, search and email. Each gets a short key, a name, a one-line description for Claude, the GitHub repository (owner/name) with the agent switch, and the Jira project key with its issue type.
5. Press **Test** next to Jira and next to each repository. Both must report success.

## Step 9. Smoke test (OPERATOR, with the agent)

1. **New idea**: "Smoke test card, delete me: show a test banner on the product page." Answer Claude's questions briefly; it searches existing cards, interviews, and saves card BD-1.
2. On the card page, record a passing result for each rung before the build. The last one hands the card off: check that the GitHub issue or the Jira ticket exists, with the spec and a link back.
3. For the agent route, watch the workflow run in the repository's Actions tab and the pull request it opens. Close it without merging.
4. On the board, open the card and press **Check now**: the handoff state follows the issue or ticket.
5. Kill the card with the reason "smoke test" and close the issue or ticket.

## Step 10. Hand over

Tell the operator, on one screen:

- the URL, who can sign in, and who the admins are;
- that conversations are private to each person, and cards are visible to everyone signed in;
- where the costs come from: Anthropic tokens and searches for the interviews, Anthropic tokens and GitHub Actions minutes for the agent, Vercel, and the database. Settings shows the tokens counted this month, and the bill is in the Anthropic Console;
- how to remove someone: take them out of the domain or the lists, or press Disable on the Settings page, which takes effect on their next request.

## Updating

Pull the new version into the company's copy and redeploy, or let the git integration deploy it. Database migrations run by themselves on the first request, under a lock, and are additive.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The sign-in page lists missing variables | Set the named variables for Production and redeploy. Environment variables apply only to new deployments. |
| Google says `redirect_uri_mismatch` | The redirect URI in step 4 must equal `<APP_URL>/auth/callback` exactly, including https and without a trailing slash. |
| "… is not on the list of people who may use this app" | Add the domain to `ALLOWED_DOMAINS` (Workspace accounts only) or the address to `ALLOWED_EMAILS`, then redeploy. |
| "No Claude model is chosen" | An admin picks one in Settings. |
| "The model … was not found" | The model was retired or the key cannot use it. Pick another in Settings; existing conversations keep the model they started with. |
| "Claude paused to stay within the time limit" | One turn took close to 300 seconds. Tap Continue. Lower the effort if it happens often. |
| Handoff blocked: no system, or no acceptance criteria | The owner refines the card with Claude, or an admin adds the system in Settings. The board shows the right button. |
| Jira answered 400 "Specify a valid issue type" | The system's Jira issue type does not exist in that project. Fix it in Settings and press Hand off. |
| Jira answered 401 or 403 | The token expired (Atlassian tokens expire after at most a year), or the service account lacks the project permission. |
| GitHub answered 403 or 404 when handing off | The token cannot see or write issues in that repository. Settings, Test shows what the token can do. |
| The issue was created but no agent run started | The workflow file is missing on the default branch, `BETDESK_SENDER` is not set or does not match the token's account, or the account lacks write access. The run's first step says which. |
| A handoff shows "got no clear answer" | GitHub or Jira timed out or answered with a server error, so the issue may exist. Press Check now: it finds the issue, or after two minutes marks the handoff failed and the card ready again. Nothing is created twice. |
| The cron returns 401 | `CRON_SECRET` is missing or was added after the last deployment. |
