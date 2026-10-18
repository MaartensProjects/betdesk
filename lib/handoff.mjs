// From a validated card to dev work. When every rung before the build has passed, the card goes to the coding
// agent (a labelled GitHub issue that the Claude Code GitHub Action in that repository picks up) or to Jira.
// The app then follows the issue, the pull request or the ticket until the work is done.
import { jiraConfigured, githubConfigured } from './config.mjs';
import { cardRef, specMarkdown, specAdf, cardUrl } from './render.mjs';
import { validRepo, cardMarker } from './github.mjs';

const OPEN = ['agent working', 'pr open', 'to do', 'in progress', 'unknown'];

export const systemOf = (settings, card) => settings.systems.find((s) => s.key === card.system) || null;

// Where a card goes. Returns { route, target, system, note } or { error, fix } where fix names the button
// that resolves it: 'refine' (the owner refines the card with Claude) or 'settings' (an admin adds the route).
export function resolveRoute(cfg, settings, card, { force = null } = {}) {
  const system = systemOf(settings, card);
  if (!system) return { error: `${cardRef(card)} has no system${card.system ? ` ("${card.system}" is not in Settings)` : ''}, so there is nowhere to send it.`, fix: card.system ? 'settings' : 'refine' };
  if (!card.body?.delivery?.acceptance_criteria?.filter(Boolean).length) return { error: `${cardRef(card)} has no acceptance criteria; a developer or the agent cannot work from it.`, fix: 'refine' };
  const agentOk = system.agent && validRepo(system.repo) && githubConfigured(cfg);
  const jiraOk = Boolean(system.jiraProject) && jiraConfigured(cfg);
  const want = force || card.route || 'jira';
  if (want === 'agent') {
    if (agentOk) return { route: 'agent', target: system.repo, system };
    const why = !githubConfigured(cfg) ? 'GITHUB_TOKEN is not set' : !validRepo(system.repo) ? `${system.name} has no repository` : `the agent is switched off for ${system.name}`;
    if (jiraOk) return { route: 'jira', target: system.jiraProject, system, note: `The card asked for the coding agent, but ${why}; it went to Jira instead.` };
    return { error: `${cardRef(card)} asks for the coding agent, but ${why}, and ${system.name} has no Jira project either.`, fix: 'settings' };
  }
  if (jiraOk) return { route: 'jira', target: system.jiraProject, system };
  const why = !jiraConfigured(cfg) ? 'Jira is not connected (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)' : `${system.name} has no Jira project`;
  return { error: `${cardRef(card)} goes to Jira, but ${why}.`, fix: 'settings' };
}

// A failure is definite when the service answered with a client error: nothing was created. Without an answer
// (timeout, dropped connection) or with a server error, the issue may exist; the status check then looks for it.
const definite = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;
const workingState = (route) => (route === 'agent' ? 'agent working' : 'to do');
const jiraLabel = (card) => `bd-${card.number}`;

// Finds the issue or ticket an earlier attempt created for this card, or null. openOnly: a new handoff reuses only
// open ones (a closed agent issue or a done ticket means that attempt is over); resolving an "unknown" handoff
// accepts any, because it looks for the one that very attempt created.
async function findExisting(ctx, card, route, target, { openOnly }) {
  if (route === 'agent') {
    const hit = await ctx.github.findIssue(target, { label: ctx.cfg.github.label, marker: cardMarker(card.id), since: new Date(card.created_at).toISOString(), state: openOnly ? 'open' : 'all' });
    return hit && { externalKey: `#${hit.number}`, url: hit.url };
  }
  const hit = await ctx.jira.findByLabel(target, jiraLabel(card), { openOnly });
  return hit && { externalKey: hit.key, url: hit.url };
}

// Hands a ready card off. ctx: { cfg, store, settings, jira, github }. actor: { id, label }.
// Returns { ok, handoff } or { error, fix }. Never creates a second issue for the same card: the card is claimed by
// moving it to "in dev" with a version check, an issue from an earlier attempt is reused, and a failure that may have
// created the issue is left for the status check to resolve instead of being retried blindly.
export async function handOff(ctx, card, actor, { force = null } = {}) {
  const { cfg, store, settings } = ctx;
  if (card.status !== 'ready for dev') return { error: `${cardRef(card)} is ${card.status}, not ready for dev.` };
  const r = resolveRoute(cfg, settings, card, { force });
  if (r.error) {
    await store.createHandoff(card.id, { route: force || card.route || '', target: '', state: 'blocked', error: r.error, createdBy: actor.id });
    await store.addEvent(card.id, { actorId: actor.id, source: actor.label, kind: 'handoff', text: `Handoff blocked: ${r.error}` });
    return r;
  }
  const claimed = await store.updateCard(card.id, card.version, { status: 'in dev' });
  if (!claimed) return { error: `${cardRef(card)} changed in the meantime; reload and try again.` };
  const title = `${cardRef(card)}: ${card.title}`;
  const where = (key) => (r.route === 'agent' ? `the coding agent: ${r.target}${key}` : `Jira: ${key}`);
  try {
    let created = await findExisting(ctx, card, r.route, r.target, { openOnly: true });
    const reused = Boolean(created);
    if (!created) {
      if (r.route === 'agent') {
        const body = `${specMarkdown(cfg, card, { systemName: r.system.name })}\n\n---\nLabelled \`${cfg.github.label}\` by ${cfg.appName}: the Claude Code GitHub Action in this repository implements it and opens a pull request that closes this issue. A developer reviews and merges it.\n${cardMarker(card.id)}`;
        const issue = await ctx.github.createIssue(r.target, { title, body, labels: [cfg.github.label] });
        created = { externalKey: `#${issue.number}`, url: issue.url };
      } else {
        const issue = await ctx.jira.createIssue({
          project: r.target,
          issueType: r.system.jiraIssueType || 'Story',
          summary: title,
          description: specAdf(cfg, card, { systemName: r.system.name }),
          labels: ['betdesk', jiraLabel(card)],
        });
        created = { externalKey: issue.key, url: issue.url };
      }
    }
    const handoff = await store.createHandoff(card.id, { route: r.route, target: r.target, ...created, state: workingState(r.route), detail: r.note || '', createdBy: actor.id });
    await store.addEvent(card.id, { actorId: actor.id, source: actor.label, kind: 'handoff', text: `Handed off to ${where(created.externalKey)} (${created.url}).${reused ? ' It was found from an earlier attempt, not created again.' : ''}${r.note ? ` ${r.note}` : ''}` });
    return { ok: true, handoff };
  } catch (e) {
    const target = r.route === 'agent' ? r.target : `Jira ${r.target}`;
    if (!definite(e)) {
      const error = `The handoff to ${target} got no clear answer (${e.message}). The issue may exist; Check now looks for it before anything is sent again.`;
      const handoff = await store.createHandoff(card.id, { route: r.route, target: r.target, state: 'unknown', error, createdBy: actor.id });
      await store.addEvent(card.id, { actorId: actor.id, source: actor.label, kind: 'handoff', text: error });
      return { error, fix: 'check', handoff };
    }
    await store.updateCard(card.id, claimed.version, { status: 'ready for dev' });
    const error = `Handoff to ${target} failed: ${e.message}`;
    await store.createHandoff(card.id, { route: r.route, target: r.target, state: 'failed', error, createdBy: actor.id });
    await store.addEvent(card.id, { actorId: actor.id, source: actor.label, kind: 'handoff', text: error });
    return { error, fix: 'retry' };
  }
}

// After a test result made a card ready: hand it off now, or leave it for an admin in approval mode.
export async function afterReady(ctx, card, actor) {
  if (ctx.settings.handoffMode === 'approval') {
    await ctx.store.addEvent(card.id, { actorId: actor.id, source: actor.label, kind: 'handoff', text: 'Ready for dev; waiting for an admin to hand it off.' });
    return { waiting: true };
  }
  return handOff(ctx, card, actor);
}

// Reads the state of one handoff and moves the card on when the work is done or was dropped. Every change is
// conditional on the state this check started from, so two checks at once log a transition only once.
export async function syncHandoff(ctx, handoff) {
  const { store } = ctx;
  const source = 'status check';
  try {
    if (handoff.state === 'unknown') {
      const card = await store.card(handoff.card_id);
      const found = await findExisting(ctx, card, handoff.route, handoff.target, { openOnly: false });
      if (found) {
        const updated = await store.updateHandoff(handoff.id, { state: workingState(handoff.route), external_key: found.externalKey, url: found.url, error: '' }, 'unknown');
        if (updated) await store.addEvent(card.id, { source, kind: 'handoff', text: `Found the issue of the earlier handoff: ${found.externalKey} (${found.url}).` });
        return updated || store.latestHandoff(card.id);
      }
      if (Date.now() - new Date(handoff.created_at).getTime() < 120_000) return handoff; // give the service a moment to index it
      const updated = await store.updateHandoff(handoff.id, { state: 'failed', error: `${handoff.error} No issue was found, so nothing was created.` }, 'unknown');
      if (updated && card.status === 'in dev') {
        const back = await store.updateCard(card.id, card.version, { status: 'ready for dev' });
        if (back) await store.addEvent(card.id, { source, kind: 'handoff', text: 'The earlier handoff did not create an issue; the card is back to ready for dev.' });
      }
      return updated || store.latestHandoff(card.id);
    }
    let state;
    let detail = '';
    let prUrl = handoff.pr_url;
    if (handoff.route === 'agent') {
      const s = await ctx.github.issueState(handoff.target, Number(handoff.external_key.replace('#', '')));
      const merged = s.pulls.find((p) => p.merged);
      const open = s.pulls.find((p) => p.state === 'open');
      prUrl = (merged || open || s.pulls[0])?.url || prUrl;
      if (merged) [state, detail] = ['done', 'pull request merged'];
      else if (s.state === 'closed' && s.stateReason === 'completed') [state, detail] = ['done', 'issue closed as completed'];
      else if (s.state === 'closed') [state, detail] = ['closed', `issue closed (${s.stateReason || 'no reason'}) without a merged pull request`];
      else if (open) [state, detail] = ['pr open', 'pull request open for review'];
      else [state, detail] = ['agent working', 'no pull request yet'];
    } else {
      const s = await ctx.jira.status(handoff.external_key);
      state = s.category === 'done' ? 'done' : s.category === 'indeterminate' ? 'in progress' : 'to do';
      detail = `${s.name}${s.resolution ? `, ${s.resolution}` : ''}`;
    }
    const updated = await store.updateHandoff(handoff.id, { state, detail, pr_url: prUrl || '', error: '' }, handoff.state);
    if (!updated) return store.latestHandoff(handoff.card_id); // another check got there first
    if (state !== handoff.state) {
      const card = await store.card(handoff.card_id);
      if (state === 'done' && card.status === 'in dev') {
        if (await store.updateCard(card.id, card.version, { status: 'done' })) await store.addEvent(card.id, { source, kind: 'status', text: `Dev work done (${detail}). Status in dev to done. Next: measure the outcome.` });
      } else if (state === 'closed' && card.status === 'in dev') {
        if (await store.updateCard(card.id, card.version, { status: 'ready for dev' })) await store.addEvent(card.id, { source, kind: 'handoff', text: `The agent's issue ${handoff.external_key} was ${detail}; ${cardRef(card)} is back to ready for dev.` });
      } else {
        await store.addEvent(card.id, { source, kind: 'handoff', text: `${handoff.route === 'agent' ? 'Agent' : 'Jira'}: ${detail}.` });
      }
    }
    return updated;
  } catch (e) {
    return store.updateHandoff(handoff.id, { error: `Status check failed: ${e.message}` });
  }
}

// Checks the open handoffs, oldest check first, within a time budget.
export async function syncAll(ctx, { budgetMs = 20000 } = {}) {
  const start = Date.now();
  let checked = 0;
  for (const h of await ctx.store.openHandoffs()) {
    if (Date.now() - start > budgetMs) break;
    await syncHandoff(ctx, h);
    checked++;
  }
  return checked;
}

export const handoffOpen = (h) => Boolean(h && OPEN.includes(h.state));
export { cardUrl };
