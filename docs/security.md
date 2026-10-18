# Security and privacy

## Who can get in

- Google sign-in only: authorization code flow with PKCE, `state` and `nonce`, the ID token verified against Google's published keys, issuer and audience checked, the email verified.
- Admission: `ADMIN_EMAILS`, `ALLOWED_EMAILS`, or a Google Workspace account whose `hd` claim is in `ALLOWED_DOMAINS`. A personal Google account with a look-alike address does not carry `hd` and is refused. Configure the OAuth app as **Internal** in Google Cloud for a second, independent check.
- The same rule runs again on every request against the stored email and domain, and the admin role is recomputed from `ADMIN_EMAILS` each time, so a change to the lists takes effect immediately. Admins can also disable a person.
- Sessions are HMAC-signed cookies (`__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`), valid for 14 days.
- After sign-in the browser only ever goes to a path on this site: the `next` value is resolved against a placeholder origin and dropped if it would leave it.

## Writes

Every POST needs the same-origin `Origin` / `Sec-Fetch-Site` headers and a CSRF token bound to the session. Pages carry a strict Content Security Policy (`default-src 'none'`, scripts and styles from the app itself only), `nosniff` and HSTS. User and Claude text is escaped, and the markdown renderer escapes first and only turns links into anchors for http(s).

## Privacy between people

- Conversations are private. Every conversation query in `lib/store.mjs` is scoped to the signed-in person; another person, admins included, gets a 404. Tests check this through the HTTP handler.
- Cards are visible to everyone signed in, so the team sees the pipeline and the interview can find duplicates and the graveyard. A card holds only what its owner agreed to save. The interviewer is told never to put customers' personal data on a card.
- Only a card's owner or an admin can change it, record its results, kill it or park it, and only the owner refines it with Claude. Anyone can start a retest, which is a new card.

## Claude

- The Anthropic API key stays on the server. Conversations go to Anthropic's API under the company's API terms; check its data retention settings in the Anthropic Console.
- Tool inputs from Claude are validated before they run, and the tools can only do what the card page can: read cards, save cards under the rules, record results and close cards.
- Card text written by other people (and web results) can try to steer Claude. So it reaches Claude marked as `<card_data>`, which the instructions say is never to be obeyed, and other people's card titles are never put into Claude's context unmarked. Claude's write tools act only on the conversation owner's own cards, admins included (admins change other people's cards on the card page). And no write runs from Claude's call: the server shows the person exactly what would be written (the whole card, the result against its pass bar, or the kill with its reason) and writes it only when they press Confirm on that one change. The Confirm applies to the card as it was shown: if the card was saved in between, the write is refused and Claude proposes again. A Confirm from an older page never confirms a newer change.
- Cost controls: an admin chooses the model and effort; an optional cap on turns per person per day; turns are bounded in rounds and time; token use per model is shown in Settings.

## The coding agent

The agent works from a GitHub issue whose text comes from a card, which is ultimately text a signed-in person typed. Treat it as untrusted input:

- The workflow starts only for the `betdesk-agent` label set by Betdesk's own account (`BETDESK_SENDER`, required), and the action itself refuses actors without write access.
- The agent runs in a job whose token is read-only, with no git credentials stored in the checkout and narrow tools: read and edit files, and local git commits. It runs no other commands, and cannot push, comment or open anything.
- The workflow never runs the repository's code. Code run in an issue-triggered job runs in the default branch's scope next to the job's secrets, and on GitHub-hosted runners it can read them from memory. So the tests run in the repository's own CI on the pull request, in that pull request's scope.
- A separate job without an agent pushes the commits to `betdesk/issue-<n>` and opens or updates the pull request. After applying the commits it checks the changed paths and refuses anything under `.github/` (workflows) or `.claude/` (Claude Code settings and hooks), even when a more powerful token is used for pushing.
- The default branch must be protected by a ruleset that requires a reviewed pull request (INSTALL.md step 7): whatever the agent does ends as a branch and a pull request, and nothing merges without a developer. Approval mode (Settings) adds a human before any issue is created.
- The prompt marks the issue text as a specification written by a person, never instructions, and tells the agent to stop and ask on anything touching payments, personal data, authentication, secrets, CI or infrastructure.
- Betdesk's own `GITHUB_TOKEN` needs only Issues read and write and Pull requests read on the target repositories.

## Secrets

All secrets are environment variables on the host. The repository has only `.env.example`, without values. `.env*` files are git-ignored. The install guide tells the installing agent never to handle secret values itself, except for generating `SESSION_SECRET` and `CRON_SECRET` straight into Vercel without displaying them.

## Reporting

Report a vulnerability privately through GitHub's "Report a vulnerability" on the repository, not in a public issue.
