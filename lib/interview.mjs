// One turn of a private conversation with Claude, on the Messages API with streaming.
// A turn runs until Claude ends it, asks a question (ask_user), or the function's time is nearly up; in the
// last case the conversation is left ready to continue. History is append-only: assistant content is stored
// and sent back exactly as the API returned it (thinking blocks included).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { SYSTEM_PROMPT, contextBlock } from './prompt.mjs';
import { CardInput, ResultInput, prepareSave, prepareResult, failedRung, STATUSES, MAX_NUMBER } from './cards.mjs';
import { cardMarkdown, cardUrl } from './render.mjs';
import { afterReady, systemOf } from './handoff.mjs';
import { localDate } from './time.mjs';

const MAX_ROUNDS = 12;
const MAX_TOKENS = 32000;
// Models that take the server-side refusal fallback ("default" form); see docs/architecture.md.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// Older models without adaptive thinking or effort; the app leaves both out for them.
const LEGACY = /claude-(3|haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4-2|sonnet-4-2)/;

export const AskInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(600),
        header: z.string().max(12).describe('A label of at most 12 characters'),
        options: z
          .array(z.object({ label: z.string().min(1).max(120), description: z.string().max(400), preview: z.string().max(4000).describe('Optional longer text shown under the option; empty if none') }))
          .min(2)
          .max(4),
        multi_select: z.boolean(),
      }),
    )
    .min(1)
    .max(4),
});
const SearchInput = z.object({ query: z.string().max(300) });
const ReadInput = z.object({ card_number: z.number().int().min(1).max(MAX_NUMBER) });
const CloseInput = z.object({
  card_number: z.number().int().min(1).max(MAX_NUMBER),
  action: z.enum(['kill', 'park']),
  reason: z.string().max(800).describe('kill: why it failed (required). park: the trigger that brings it back (required)'),
  revive: z.string().max(400).describe('kill only: what would revive it; empty if none'),
});

const schema = (zodSchema) => {
  const s = z.toJSONSchema(zodSchema);
  delete s.$schema;
  return s;
};

// Client tools first, in a fixed order, so the tool list (and the prompt cache) never changes between turns.
export function toolDefinitions(settings) {
  const tools = [
    { name: 'ask_user', description: 'Ask the person one to four questions, each with two to four tappable options; they can always type their own answer instead. Ends your turn until they answer. Write anything they must judge into a visible message or the previews first.', input_schema: schema(AskInput) },
    { name: 'search_cards', description: 'Search every bet card in the company (any owner, any status, the graveyard included) by key words. Returns number, title, status, owner, system and, for killed or parked cards, the reason.', input_schema: schema(SearchInput) },
    { name: 'read_card', description: 'Read one card in full, with its ladder and evidence log.', input_schema: schema(ReadInput) },
    { name: 'save_bet_card', description: 'Create a card (card_number 0) or save a refined version of one of the person\'s own cards (its number). The app checks the rules: errors come back to you to fix; otherwise it shows the person the whole card and saves it only when they confirm. The result tells you which.', input_schema: schema(CardInput) },
    { name: 'record_test_result', description: 'Record the result and verdict of the next rung of one of the person\'s own cards. The app shows the person the result against the pass bar and records it only when they confirm. When every rung before the build has passed, the card is handed off to dev work.', input_schema: schema(ResultInput) },
    { name: 'close_card', description: 'Kill one of the person\'s own cards (with the reason) or park it (with the trigger that brings it back). The app asks the person to confirm first.', input_schema: schema(CloseInput) },
  ].map((t) => ({ ...t, eager_input_streaming: true }));
  if (settings.webSearch) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  return tools;
}

export const actorLabel = (user) => `Claude in ${user.name || user.email}'s conversation`;
// Claude writes only to the person's own cards, admins included: card text written by others reaches Claude through
// search_cards and read_card, so another card's text must never be able to steer a write to someone else's card.
// Admins change other people's cards on the card page, by hand.
const canChange = (user, card) => card && card.owner_id === user.id;
// A confirmed write applies only to the card as it was when the person saw the proposal (ctx.expectVersion);
// if it was saved in between, in another conversation or on the card page, the write is refused.
const changedSince = (ctx, card) => card && ctx.expectVersion !== undefined && card.version !== ctx.expectVersion;
const CHANGED = (card) => `Nothing was written: BD-${card.number} changed after the person saw your proposal. Read it again with read_card and propose the change again.`;
const textResult = (id, text, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) });
// Card text is written by people; it reaches Claude as data, marked so the instructions can say never to obey it.
const cardData = (text) => `<card_data>\n${String(text).replaceAll('</card_data>', '</card-data>')}\n</card_data>`;
// Writes never run straight from Claude's call: the app shows the person exactly what would be written and runs the
// write only when they press Confirm on that change (proposeWrite, then runTool on the confirm POST).
export const WRITES = new Set(['save_bet_card', 'record_test_result', 'close_card']);

// ---------- tools ----------
async function runTool(ctx, block, emit) {
  const { store, user, cfg, settings, conversation } = ctx;
  const input = block.input || {};
  const invalid = (parsed) => textResult(block.id, JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }), true);

  if (block.name === 'search_cards') {
    const p = SearchInput.safeParse(input);
    if (!p.success) return invalid(p);
    const found = await store.searchCards(p.data.query);
    if (!found.length) return textResult(block.id, 'No cards match.');
    const lines = found.map((c) => {
      const v = c.body.verdict;
      const failed = failedRung(c.ladder);
      return `BD-${c.number} · ${c.title} · ${c.status}${failed ? ` (rung ${failed.rung} failed: ${failed.result})` : ''} · owner ${c.owner_name || c.owner_email} · system ${c.system || 'none'} · problem: ${(c.body.problem?.problem || '').slice(0, 160)}${v ? ` · ${v.status} because: ${v.reason}${v.revive ? `; revive: ${v.revive}` : ''}` : ''}`;
    });
    return textResult(block.id, cardData(lines.join('\n')));
  }

  if (block.name === 'read_card') {
    const p = ReadInput.safeParse(input);
    if (!p.success) return invalid(p);
    const card = await store.cardByNumber(p.data.card_number);
    if (!card) return textResult(block.id, `There is no card BD-${p.data.card_number}.`, true);
    return textResult(block.id, cardData(cardMarkdown(card, { events: await store.events(card.id), systemName: systemOf(settings, card)?.name })));
  }


  if (block.name === 'save_bet_card') {
    const n = Number(input.card_number || 0);
    const existing = n ? await store.cardByNumber(n) : null;
    if (n && !existing) return textResult(block.id, `There is no card BD-${n}; use 0 for a new card.`, true);
    if (changedSince(ctx, existing)) return textResult(block.id, CHANGED(existing), true);
    if (existing && !canChange(user, existing)) return textResult(block.id, `BD-${n} belongs to ${existing.owner_name}; only its owner changes it. Tell the person to ask the owner; do not copy it into a new card.`, true);
    const ownerId = existing ? existing.owner_id : user.id;
    const prepared = prepareSave(input, {
      existing,
      systems: settings.systems,
      today: ctx.today,
      actor: actorLabel(user),
      wipLimit: settings.wipLimit,
      inValidationByOwner: await store.countInValidation(ownerId),
    });
    if (prepared.errors.length) return textResult(block.id, `Not saved. Fix these and save again:\n- ${prepared.errors.join('\n- ')}`, true);
    let card;
    if (existing) {
      card = await store.updateCard(existing.id, existing.version, { ...prepared.row, body: { ...prepared.row.body, verdict: existing.body.verdict } });
      if (!card) return textResult(block.id, `BD-${n} changed while you worked on it. Call read_card and save again.`, true);
    } else {
      card = await store.createCard(user.id, prepared.row);
    }
    for (const e of prepared.events) await store.addEvent(card.id, { actorId: user.id, source: actorLabel(user), kind: e.kind, text: e.text });
    if (!conversation.card_id) await store.updateConversation(user.id, conversation.id, { card_id: card.id, title: card.title });
    conversation.card_id = card.id;
    emit({ type: 'card', number: card.number, title: card.title });
    let handoff = '';
    if (card.status === 'ready for dev' && existing?.status !== 'ready for dev') handoff = await handoffNote(ctx, card);
    const warn = prepared.warnings.length ? `\nWarnings to mention:\n- ${prepared.warnings.join('\n- ')}` : '';
    return textResult(block.id, `Saved BD-${card.number} (${card.status}): ${cardUrl(cfg, card)}${warn}${handoff}`);
  }

  if (block.name === 'record_test_result') {
    const p = ResultInput.safeParse(input);
    if (!p.success) return invalid(p);
    const card = await store.cardByNumber(p.data.card_number);
    if (!card) return textResult(block.id, `There is no card BD-${p.data.card_number}.`, true);
    if (!canChange(user, card)) return textResult(block.id, `BD-${card.number} belongs to ${card.owner_name}; only its owner records its results from a conversation.`, true);
    if (changedSince(ctx, card)) return textResult(block.id, CHANGED(card), true);
    const r = prepareResult(card, p.data, actorLabel(user));
    if (r.error) return textResult(block.id, `Not recorded: ${r.error}`, true);
    const updated = await store.updateCard(card.id, card.version, { ladder: r.ladder, status: r.status, ...(r.nextTestDate !== undefined ? { next_test_date: r.nextTestDate } : {}) });
    if (!updated) return textResult(block.id, `BD-${card.number} changed in the meantime. Call read_card and try again.`, true);
    await store.addEvent(card.id, { actorId: user.id, source: actorLabel(user), kind: 'result', text: r.event.text });
    emit({ type: 'card', number: updated.number, title: updated.title });
    if (r.failed) return textResult(block.id, `Recorded: rung ${p.data.rung} failed. The card cannot continue. Ask whether to kill it (the reason is required) or park it (on a named trigger), then call close_card. A retest is a new card.`);
    if (r.ready) return textResult(block.id, `Recorded. Every rung before the build has passed.${await handoffNote(ctx, updated)}`);
    return textResult(block.id, `Recorded. Next: rung ${p.data.rung + 1}${r.nextTestDate ? ` on ${r.nextTestDate}` : ', not dated yet: ask for the date and save the card'}.`);
  }

  if (block.name === 'close_card') {
    const p = CloseInput.safeParse(input);
    if (!p.success) return invalid(p);
    const card = await store.cardByNumber(p.data.card_number);
    if (!card) return textResult(block.id, `There is no card BD-${p.data.card_number}.`, true);
    if (!canChange(user, card)) return textResult(block.id, `BD-${card.number} belongs to ${card.owner_name}; only its owner closes it from a conversation.`, true);
    if (changedSince(ctx, card)) return textResult(block.id, CHANGED(card), true);
    const r = await closeCard(store, card, { ...p.data, actor: { id: user.id, label: actorLabel(user) } });
    if (r.error) return textResult(block.id, r.error, true);
    emit({ type: 'card', number: card.number, title: card.title });
    return textResult(block.id, `BD-${card.number} is ${r.status}.`);
  }

  return textResult(block.id, `Unknown tool ${block.name}.`, true);
}

// Checks a write without doing it, and describes exactly what it would do. Returns { result } (an error for Claude
// to fix, no confirmation needed) or { title, summary, detail } for the person to confirm.
export async function proposeWrite(ctx, block) {
  const { store, user, settings } = ctx;
  const input = block.input || {};
  const fail = (text) => ({ result: textResult(block.id, text, true) });
  if (block.name === 'save_bet_card') {
    const n = Number(input.card_number || 0);
    const existing = n ? await store.cardByNumber(n) : null;
    if (n && !existing) return fail(`There is no card BD-${n}; use 0 for a new card.`);
    if (existing && !canChange(user, existing)) return fail(`BD-${n} belongs to ${existing.owner_name}; only its owner changes it. Tell the person to ask the owner; do not copy it into a new card.`);
    const prepared = prepareSave(input, { existing, systems: settings.systems, today: ctx.today, actor: actorLabel(user), wipLimit: settings.wipLimit, inValidationByOwner: await store.countInValidation(existing ? existing.owner_id : user.id) });
    if (prepared.errors.length) return fail(`Not saved. Fix these and save again:\n- ${prepared.errors.join('\n- ')}`);
    const row = prepared.row;
    const preview = { ...row, number: existing?.number, owner_name: existing ? existing.owner_name : user.name || user.email, next_test_date: row.next_test_date || '', kill_date: row.kill_date || '' };
    const next = row.ladder.find((r) => !r.build && !r.verdict);
    const lines = [
      row.title,
      `Status: ${row.status}${row.status === 'ready for dev' ? ', which hands it off to dev work' : ''}`,
      next ? `Next test: rung ${next.rung} (${next.name})${row.next_test_date ? ` on ${row.next_test_date}` : ''}. Pass bar: ${next.pass_bar || 'not written yet'}` : '',
      existing ? `What changed: ${String(input.change_note || '').trim()}` : '',
      ...prepared.warnings.map((w) => `Note: ${w}`),
    ].filter(Boolean);
    return { title: existing ? `Save the changes to BD-${n}?` : 'Save this new card?', summary: lines.join('\n'), detail: cardMarkdown(preview, { systemName: systemOf(settings, preview)?.name }), version: existing ? existing.version : null };
  }
  if (block.name === 'record_test_result') {
    const p = ResultInput.safeParse(input);
    if (!p.success) return fail(JSON.stringify({ INVALID_INPUT: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }));
    const card = await store.cardByNumber(p.data.card_number);
    if (!card) return fail(`There is no card BD-${p.data.card_number}.`);
    if (!canChange(user, card)) return fail(`BD-${card.number} belongs to ${card.owner_name}; only its owner records its results from a conversation.`);
    const r = prepareResult(card, p.data, actorLabel(user));
    if (r.error) return fail(`Not recorded: ${r.error}`);
    const rung = card.ladder.find((x) => x.rung === p.data.rung);
    const after = r.failed ? 'A fail ends the card: it is then killed or parked.' : r.ready ? (settings.handoffMode === 'approval' ? 'Every rung before the build has then passed; an admin hands it off.' : 'Every rung before the build has then passed, and the card is handed off to dev work at once.') : '';
    return {
      title: `Record rung ${rung.rung} of BD-${card.number} as ${p.data.verdict}?`,
      summary: [`BD-${card.number}: ${card.title}`, `Rung ${rung.rung}, ${rung.name}: ${rung.test}`, `Pass bar${rung.pass_bar_at ? `, written ${rung.pass_bar_at.slice(0, 10)}` : ''}: ${rung.pass_bar || 'none'}`, `Result: ${p.data.result}`, p.data.source ? `Source: ${p.data.source}` : '', `Verdict: ${p.data.verdict}`, after].filter(Boolean).join('\n'),
      detail: '',
      version: card.version,
    };
  }
  if (block.name === 'close_card') {
    const p = CloseInput.safeParse(input);
    if (!p.success) return fail(JSON.stringify({ INVALID_INPUT: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }));
    const card = await store.cardByNumber(p.data.card_number);
    if (!card) return fail(`There is no card BD-${p.data.card_number}.`);
    if (!canChange(user, card)) return fail(`BD-${card.number} belongs to ${card.owner_name}; only its owner closes it from a conversation.`);
    const why = closeCheck(card, p.data);
    if (why) return fail(why);
    const kill = p.data.action === 'kill';
    return {
      title: `${kill ? 'Kill' : 'Park'} BD-${card.number}?`,
      summary: [`BD-${card.number}: ${card.title}`, `${kill ? 'Reason' : 'Back when'}: ${p.data.reason.trim()}`, kill && p.data.revive.trim() ? `Revive only if: ${p.data.revive.trim()}` : '', kill ? 'It goes to the graveyard; nothing is erased.' : ''].filter(Boolean).join('\n'),
      detail: '',
      version: card.version,
    };
  }
  return fail(`Unknown tool ${block.name}.`);
}

async function handoffNote(ctx, card) {
  const r = await afterReady(ctx.handoff, card, { id: ctx.user.id, label: actorLabel(ctx.user) });
  if (r.waiting) return ' It now waits for an admin to hand it off; tell the person.';
  if (r.ok) return ` It was handed off: ${r.handoff.route === 'agent' ? 'the coding agent works on' : 'Jira ticket'} ${r.handoff.target}${r.handoff.external_key} (${r.handoff.url}). Tell the person.`;
  return ` The handoff did not go through: ${r.error} Tell the person; the card page has the button to fix it.`;
}

// Why a kill or park cannot happen, or null.
export function closeCheck(card, { action, reason }) {
  if (!String(reason || '').trim()) return action === 'kill' ? 'A kill needs a reason: later interviews learn from it.' : 'Parking needs the trigger that brings the card back.';
  if (!['inbox', 'in validation', 'ready for dev', 'parked'].includes(card.status) || (action === 'park' && card.status === 'parked')) return `BD-${card.number} is ${card.status}; it cannot be ${action === 'kill' ? 'killed' : 'parked'} now.`;
  return null;
}

// Kill or park, with the reason required. Shared by the close_card tool and the card page.
export async function closeCard(store, card, { action, reason, revive = '', actor }) {
  const why = String(reason || '').trim();
  const problem = closeCheck(card, { action, reason });
  if (problem) return { error: problem };
  const status = action === 'kill' ? 'killed' : 'parked';
  const verdict = { status, reason: why, revive: String(revive || '').trim(), at: new Date().toISOString(), by: actor.label };
  const updated = await store.updateCard(card.id, card.version, { status, body: { ...card.body, verdict } });
  if (!updated) return { error: `BD-${card.number} changed in the meantime; reload and try again.` };
  await store.addEvent(card.id, { actorId: actor.id, source: actor.label, kind: status, text: action === 'kill' ? `Killed: ${why}${verdict.revive ? ` · revive: ${verdict.revive}` : ''}` : `Parked until: ${why}` });
  return { status };
}

// ---------- the person's message ----------
function answerText(pending, answers) {
  return pending.questions
    .map((q, i) => {
      const a = answers?.[i] || {};
      const picked = (a.choices || []).filter((c) => q.options.some((o) => o.label === c));
      const other = String(a.other || '').trim();
      const parts = [...picked, ...(other ? [`their own answer: ${other}`] : [])];
      return `${q.question}\nAnswer: ${parts.length ? parts.join('; ') : '(no answer)'}`;
    })
    .join('\n\n');
}

// A conversation can continue without a new message when its last turn was cut off: the history ends with the
// person's message or tool results, or with a response the API paused (pause_turn). Ending on any other response of
// Claude's would make the API read it as a prefill, which current models refuse.
export function canResume(messages, pending) {
  if (pending) return false;
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === 'user') return true;
  return last.stop_reason === 'pause_turn' || last.content.some((b) => b.type === 'tool_use');
}

// Tool calls left without a result by a turn that was cut off, answered so the history stays valid.
export function orphanResults(history) {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant') return [];
  return last.content.filter((b) => b.type === 'tool_use').map((b) => textResult(b.id, 'The previous turn was cut off before this tool ran. Call it again if it is still needed.', true));
}

// pendingResult: the outcome of a confirmed or declined write (runTurn computes it); otherwise the answers.
export function buildUserContent({ conversation, history, input, context, pendingResult = null }) {
  const content = [];
  if (conversation.pending) {
    content.push(...(conversation.pending.results || []), pendingResult || textResult(conversation.pending.tool_use_id, answerText(conversation.pending, input.answers)));
  } else {
    content.push(...orphanResults(history));
  }
  if (context) content.push({ type: 'text', text: context });
  const text = String(input.text || '').trim();
  if (text) content.push({ type: 'text', text });
  return content;
}

const supportsAdaptive = (model) => !LEGACY.test(model);

export function requestParams({ model, effort, settings, messages }) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    ...(supportsAdaptive(model) ? { thinking: { type: 'adaptive' }, ...(effort ? { output_config: { effort } } : {}) } : {}),
    tools: toolDefinitions(settings),
    messages,
    ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };
}

const TOOL_NOTE = {
  search_cards: (i) => `Searched cards: ${i.query || ''}`,
  read_card: (i) => `Read BD-${i.card_number}`,
  save_bet_card: (i) => (i.card_number ? `Proposed changes to BD-${i.card_number}` : 'Proposed a card'),
  record_test_result: (i) => `Proposed result for rung ${i.rung} of BD-${i.card_number}: ${i.verdict}`,
  close_card: (i) => `Proposed to ${i.action === 'kill' ? 'kill' : 'park'} BD-${i.card_number}`,
  ask_user: () => 'Asking you',
  web_search: (i) => `Searched the web: ${i.query || ''}`,
};
export const toolNote = (name, input) => (TOOL_NOTE[name] ? TOOL_NOTE[name](input || {}) : name);

// Runs one turn. t: { store, cfg, settings, client, user, conversation, card, input: { text, answers, resume },
// emit(event), deadlineMs, handoff (the handoff context) }. Returns { status, error? }.
export async function runTurn(t) {
  const { store, cfg, settings, client, user, emit = () => {} } = t;
  const conversation = { ...t.conversation };
  const today = localDate(Date.now(), cfg.timeZone);
  const ctx = { store, cfg, settings, user, conversation, today, handoff: t.handoff };
  const hardDeadline = t.hardDeadlineMs ?? t.deadlineMs + 60_000;
  const finish = async (status, pending = null) => {
    await store.updateConversation(user.id, conversation.id, { status, pending, running_since: null });
    return status;
  };
  try {
    const stored = await store.messages(conversation.id);
    let history = stored.map((m) => ({ role: m.role, content: m.content }));
    const needsContext = conversation.context_date !== today;
    const context = needsContext ? contextBlock({ cfg, settings, user, today, conversation, card: t.card }) : '';
    // A write waiting for the person: run it on Confirm, tell Claude it was declined otherwise.
    let pendingResult = null;
    const p = conversation.pending;
    if (p?.type === 'confirm') {
      if (t.input.decision === 'confirm') {
        try {
          // null for a new card: there is nothing it could have changed against.
          pendingResult = await runTool({ ...ctx, expectVersion: p.version ?? undefined }, { id: p.tool_use_id, name: p.tool, input: p.input }, emit);
        } catch (e) {
          console.error(`confirmed ${p.tool} failed:`, e);
          pendingResult = textResult(p.tool_use_id, `The write failed: ${e.message}`, true);
        }
      } else pendingResult = textResult(p.tool_use_id, 'The person did not confirm, so nothing was written. Ask what to change.', true);
    }
    const content = buildUserContent({ conversation, history, input: t.input, context, pendingResult });
    const human = Boolean(String(t.input.text || '').trim() || conversation.pending);
    if (!human && !(t.input.resume && canResume(stored, conversation.pending))) return { status: await finish(conversation.pending ? 'waiting' : 'idle', conversation.pending), error: 'Nothing to send.' };
    if (content.length) {
      await store.appendMessage(conversation.id, 'user', content, { turn: human });
      history.push({ role: 'user', content });
    }
    await store.updateConversation(user.id, conversation.id, { pending: null, ...(needsContext ? { context_date: today } : {}) });
    conversation.pending = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (Date.now() > t.deadlineMs) {
        emit({ type: 'paused', text: 'Claude paused to stay within the time limit of one request. Tap Continue to go on.' });
        return { status: await finish('idle'), paused: true };
      }
      let message;
      // A call still running near the platform's limit is aborted, so the turn ends cleanly and can be continued,
      // instead of the function being killed with the conversation still marked as running.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(0, hardDeadline - Date.now()));
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(requestParams({ model: conversation.model, effort: conversation.effort, settings, messages: history }), { signal: abort.signal });
          for await (const ev of stream) {
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit({ type: 'text', text: ev.delta.text });
            else if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') emit({ type: 'tool', text: 'Searching the web' });
            else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') emit({ type: 'thinking' });
          }
          message = await stream.finalMessage();
          break;
        } catch (e) {
          if (abort.signal.aborted) {
            clearTimeout(timer);
            emit({ type: 'paused', text: 'Claude was stopped at the time limit of one request. Tap Continue to go on.' });
            return { status: await finish('idle'), paused: true };
          }
          // With eager input streaming the SDK rejects when a tool input is not valid JSON; only that is retried.
          if (e instanceof Anthropic.APIError || attempt >= 2) {
            clearTimeout(timer);
            throw e;
          }
          console.error('tool input was not parseable JSON; asking again:', e.message);
        }
      }
      clearTimeout(timer);
      await store.appendMessage(conversation.id, 'assistant', message.content, { usage: message.usage, model: message.model, stopReason: message.stop_reason });
      history.push({ role: 'assistant', content: message.content });
      emit({ type: 'message' });

      if (message.stop_reason === 'pause_turn') continue;
      if (message.stop_reason === 'refusal') {
        emit({ type: 'note', text: 'Claude declined to continue this request.' });
        return { status: await finish('idle') };
      }
      const calls = message.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) return { status: await finish('idle') };
      if (message.stop_reason === 'max_tokens') {
        const results = calls.map((b) => textResult(b.id, 'Your output was cut off at the token limit before this call was complete. Send it again, shorter.', true));
        await store.appendMessage(conversation.id, 'user', results);
        history.push({ role: 'user', content: results });
        continue;
      }
      // ask_user and the write tools stop the turn for the person; one such stop per response.
      const results = [];
      let ask = null;
      for (const b of calls) {
        if (b.name === 'ask_user') {
          const p = AskInput.safeParse(b.input);
          if (!p.success) results.push(textResult(b.id, JSON.stringify({ INVALID_INPUT: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }), true));
          else if (ask) results.push(textResult(b.id, 'One question batch or one change at a time; call it again after the person answered.', true));
          else ask = { type: 'ask', tool_use_id: b.id, questions: p.data.questions };
          continue;
        }
        if (WRITES.has(b.name)) {
          if (ask) {
            results.push(textResult(b.id, 'One question batch or one change at a time; call it again after the person answered.', true));
            continue;
          }
          emit({ type: 'tool', text: toolNote(b.name, b.input) });
          let proposal;
          try {
            proposal = await proposeWrite(ctx, b);
          } catch (e) {
            console.error(`checking ${b.name} failed:`, e);
            proposal = { result: textResult(b.id, `The tool failed: ${e.message}`, true) };
          }
          if (proposal.result) results.push(proposal.result);
          else ask = { type: 'confirm', tool_use_id: b.id, tool: b.name, input: b.input, title: proposal.title, summary: proposal.summary, detail: proposal.detail, version: proposal.version };
          continue;
        }
        emit({ type: 'tool', text: toolNote(b.name, b.input) });
        try {
          results.push(await runTool(ctx, b, emit));
        } catch (e) {
          // A failing tool is Claude's to handle, not the end of the turn.
          console.error(`tool ${b.name} failed:`, e);
          results.push(textResult(b.id, `The tool failed: ${e.message}`, true));
        }
      }
      if (ask) {
        emit({ type: 'question' });
        return { status: await finish('waiting', { ...ask, results }) };
      }
      await store.appendMessage(conversation.id, 'user', results);
      history.push({ role: 'user', content: results });
    }
    emit({ type: 'paused', text: 'Claude used many steps in this turn and paused. Tap Continue to go on.' });
    return { status: await finish('idle'), paused: true };
  } catch (e) {
    const msg =
      e instanceof Anthropic.AuthenticationError
        ? 'The Anthropic API key was refused. An admin must check ANTHROPIC_API_KEY.'
        : e instanceof Anthropic.RateLimitError
          ? 'Claude is rate limited right now. Try again in a minute.'
          : e instanceof Anthropic.NotFoundError
            ? `The model "${conversation.model}" was not found. An admin can pick another one in Settings.`
            : e instanceof Anthropic.APIError
              ? `Claude answered with an error (${e.status}): ${e.message}`
              : `The turn failed: ${e.message}`;
    console.error('turn failed:', e);
    emit({ type: 'error', text: msg });
    return { status: await finish('idle'), error: msg };
  }
}

export { STATUSES };
