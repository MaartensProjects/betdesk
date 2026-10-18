// What needs someone's attention on a card, and the button that resolves each item. Pure; the board and the
// card page render these. Owners see their own cards' items; admins also see every card's handoff items.
import { failedRung, nextRung } from './cards.mjs';
import { resolveRoute } from './handoff.mjs';
import { shortDate } from './time.mjs';
import { jiraConfigured } from './config.mjs';

// Returns [{ text, buttons: [kind], who: 'owner'|'admin' }].
export function attention(card, { today, handoff, settings, cfg }) {
  const items = [];
  const add = (text, buttons, who = 'owner') => items.push({ text, buttons, who });
  if (card.status === 'in validation' || card.status === 'inbox') {
    const failed = failedRung(card.ladder);
    const next = nextRung(card.ladder);
    if (failed) add(`Rung ${failed.rung} (${failed.name}) failed: ${failed.result}. Kill it with the reason, or park it on a trigger. A retest is a new card.`, ['kill', 'park', 'retest']);
    else if (card.status === 'in validation') {
      if (!card.next_test_date) add(`Rung ${next?.rung} has no date.`, ['refine']);
      else if (card.next_test_date === today) add(`Today: rung ${next?.rung}, ${next?.test} Pass bar: ${next?.pass_bar || 'not written'}.`, ['record', 'refine']);
      else if (card.next_test_date < today) add(`The test of ${shortDate(card.next_test_date)} (rung ${next?.rung}) has no result.`, ['record', 'refine']);
      if (card.kill_date && card.kill_date < today) add(`The kill date (${shortDate(card.kill_date)}) has passed without the ladder passing.`, ['kill', 'refine']);
    }
  }
  if (card.status === 'ready for dev') {
    if (handoff && ['blocked', 'failed'].includes(handoff.state)) {
      // What blocks it now, if anything; otherwise the last attempt's error with a retry.
      const r = resolveRoute(cfg, settings, card);
      const fix = r.error ? (r.fix === 'refine' ? ['refine'] : ['settings']) : ['handoff'];
      if (handoff.route === 'agent' && jiraConfigured(cfg)) fix.push('handoff-jira');
      add(r.error ? `${r.error} Last attempt: ${handoff.error}` : `${handoff.error} Try again, or fix it at the other end first.`, fix, r.error && r.fix === 'settings' ? 'admin' : 'owner');
    } else if (handoff && handoff.state === 'closed') {
      add(`The coding agent's issue ${handoff.target}${handoff.external_key} was closed without a merged pull request.`, ['handoff', ...(jiraConfigured(cfg) ? ['handoff-jira'] : [])], 'admin');
    } else {
      const r = resolveRoute(cfg, settings, card);
      if (r.error) add(r.error, r.fix === 'refine' ? ['refine'] : ['settings'], r.fix === 'settings' ? 'admin' : 'owner');
      else if (settings.handoffMode === 'approval') add(`Every rung before the build has passed. It goes to ${r.route === 'agent' ? `the coding agent (${r.target})` : `Jira (${r.target})`} when an admin hands it off.`, ['handoff'], 'admin');
      else add(`Every rung before the build has passed, but the handoff has not run yet.`, ['handoff'], 'admin');
    }
  }
  if (card.status === 'in dev' && handoff?.error) add(handoff.error, ['check']);
  return items;
}

// The items a given person should act on. Admins see every card's items, but "Work on it with Claude" belongs to the
// owner alone (Claude writes only to the person's own cards), so for others it becomes a link to the card.
export function itemsFor(items, card, user) {
  const own = card.owner_id === user.id;
  return items
    .filter((i) => (i.who === 'owner' && own) || user.role === 'admin')
    .map((i) => {
      if (own) return i;
      const buttons = i.buttons.filter((b) => b !== 'refine');
      return { ...i, buttons: buttons.length ? buttons : ['open'] };
    });
}

// Configuration gaps an admin should fix, each with its button.
export function setupWarnings({ cfg, settings }) {
  const w = [];
  if (!settings.model) w.push({ text: 'No Claude model is chosen, so nobody can start a conversation. The model decides the cost per conversation.', button: 'settings' });
  if (!cfg.anthropicApiKey) w.push({ text: 'ANTHROPIC_API_KEY is not set in the environment.', button: 'settings' });
  if (!settings.systems.length) w.push({ text: 'No systems are set up, so no card can be handed off. Add the webshop and its supporting systems, each with its repository and/or Jira project.', button: 'settings' });
  return w;
}
