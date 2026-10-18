// Local development only: fills the PGlite database in .data/pglite with demo cards in each state, two people and a
// conversation with an open question, so every page has something to show. Run before `npm run dev`:
//   node dev/seed.mjs && DEV_LOGIN_EMAIL=admin@shop.example npm run dev
import { pglite } from './pglite.mjs';
import { migrate } from '../lib/db.mjs';
import { Store } from '../lib/store.mjs';
import { prepareSave, prepareResult } from '../lib/cards.mjs';
import { localDate } from '../lib/time.mjs';

const db = await pglite('.data/pglite');
await migrate(db);
const store = new Store(db);
const today = localDate(Date.now(), 'UTC');
const addDays = (n) => localDate(Date.now() + n * 864e5, 'UTC');

const systems = [
  { key: 'web', name: 'Webshop front end', description: 'storefront, product pages, checkout UI', repo: 'example/storefront', jiraProject: 'WEB', jiraIssueType: 'Story', agent: true },
  { key: 'erp', name: 'ERP', description: 'stock, orders, invoices', repo: '', jiraProject: 'ERP', jiraIssueType: 'Task', agent: false },
  { key: 'pim', name: 'Product information', description: 'product data and images', repo: '', jiraProject: 'PIM', jiraIssueType: 'Story', agent: false },
];
await store.setSetting('model', 'claude-opus-5-5', null);
await store.setSetting('effort', 'high', null);
await store.setSetting('systems', systems, null);

const admin = await store.upsertUser({ email: 'admin@shop.example', name: 'Sam (product owner)', role: 'admin', domain: 'shop.example' });
const ann = await store.upsertUser({ email: 'ann@shop.example', name: 'Ann (customer service)', role: 'member', domain: 'shop.example' });

const base = (over) => ({
  card_number: 0,
  system: 'web',
  problem: { who: 'Mobile shoppers', problem: 'They leave checkout when shipping costs appear on the last step', why_now: 'Mobile abandonment rose from 68% to 74% last quarter (analytics, read by Sam)' },
  outcome: { metric: 'Mobile checkout conversion', target: '+0.3 percentage points', by_date: addDays(120), measured_by: 'Analytics checkout funnel, read by the product owner' },
  value: { estimate: 'About €4,000 a month of gross margin (Sam\'s estimate from 0.3 pp × mobile sessions × margin)', cost: 'Two developer days (estimate)' },
  riskiest_assumption: { kind: 'value', statement: 'Showing shipping costs on the product page raises mobile conversion by at least 0.3 pp' },
  ladder: [
    { rung: 1, name: 'Desk check', test: 'Funnel data: where do mobile shoppers drop, and how many on the shipping step?', pass_bar: 'At least 20% of mobile drops happen on the shipping step', judge: 'Sam', time_box: '2 hours', budget: '€0', build: false },
    { rung: 2, name: 'Customer evidence', test: 'Five calls with customers who abandoned a mobile checkout last month', pass_bar: '3 of 5 name the late shipping cost unprompted', judge: 'Sam', time_box: '1 week', budget: '€0', build: false },
    { rung: 3, name: 'Spec ready', test: 'Acceptance criteria and measurement plan reviewed by the product owner', pass_bar: 'Sam signs off the spec', judge: 'Sam', time_box: '1 day', budget: '€0', build: false },
    { rung: 4, name: 'Build', test: 'The coding agent adds the shipping line to product pages', pass_bar: '', judge: '', time_box: '', budget: '', build: true },
  ],
  pass_bar_changes: [],
  status: 'in validation',
  next_test_date: today,
  kill_date: addDays(90),
  limits: { time: '2 hours a week', budget: '€0', kill_criterion: 'Any rung fails, or nothing passes by the kill date', displaces: 'Nothing' },
  flags: { personal_data: 'no', payments: 'no', legal: 'no', notes: '' },
  delivery: { route: 'agent', reason: 'Small, contained storefront change', acceptance_criteria: ['Every product page shows the shipping cost for the shopper\'s country under the price', 'The amount matches the checkout for the same basket'] },
  change_note: '',
  ...over,
});

async function make(owner, input, results = [], after = null) {
  const r = prepareSave(input, { existing: null, systems, today, actor: `Claude in ${owner.name}'s conversation` });
  if (r.errors.length) throw new Error(r.errors.join('; '));
  let card = await store.createCard(owner.id, r.row);
  await store.addEvent(card.id, { actorId: owner.id, source: `Claude in ${owner.name}'s conversation`, kind: 'created', text: 'Card created in an interview.' });
  for (const res of results) {
    const p = prepareResult(card, { card_number: card.number, next_test_date: '', source: '', ...res }, `typed by ${owner.name}`);
    if (p.error) throw new Error(p.error);
    card = await store.updateCard(card.id, card.version, { ladder: p.ladder, status: p.status, next_test_date: p.nextTestDate });
    await store.addEvent(card.id, { actorId: owner.id, source: `typed by ${owner.name}`, kind: 'result', text: p.event.text });
  }
  if (after) card = await after(card);
  return card;
}

await make(admin, base({ title: 'Show shipping costs on the product page' }));
await make(ann, base({ title: 'Delivery date promise in the basket', next_test_date: addDays(-2), problem: { who: 'Customers who ask customer service where their order is', problem: '"When will it arrive?" is 30% of our tickets', why_now: 'Peak season starts in five weeks' } }), [{ rung: 1, result: '31% of 2,140 tickets in September ask for a delivery date', verdict: 'pass', source: 'Zendesk export' }]);
await make(ann, base({ title: 'Gift wrapping as a paid option', system: 'erp', delivery: { route: 'jira', reason: 'Touches order lines and invoices', acceptance_criteria: ['Gift wrap is an order line with its own SKU', 'The invoice shows it'] } }), [
  { rung: 1, result: '412 searches for "gift wrap" in November last year', verdict: 'pass', source: 'site search' },
  { rung: 2, result: '4 of 5 would pay €3.50', verdict: 'pass', source: 'call notes' },
  { rung: 3, result: 'Spec signed off', verdict: 'pass', source: 'Sam' },
], async (card) => {
  await store.createHandoff(card.id, { route: 'jira', target: 'ERP', state: 'failed', error: 'Handoff to Jira ERP failed: Jira answered 400: issuetype: Specify a valid issue type', createdBy: ann.id });
  return card;
});
await make(admin, base({ title: 'Size advice on jeans product pages' }), [
  { rung: 1, result: '18% of jeans are returned for size', verdict: 'pass', source: 'returns report' },
  { rung: 2, result: '5 of 5 asked for a size guide', verdict: 'pass', source: 'calls' },
  { rung: 3, result: 'Signed off', verdict: 'pass', source: 'Sam' },
], async (card) => {
  card = await store.updateCard(card.id, card.version, { status: 'in dev' });
  await store.createHandoff(card.id, { route: 'agent', target: 'example/storefront', externalKey: '#118', url: 'https://github.com/example/storefront/issues/118', state: 'pr open', detail: 'pull request open for review', createdBy: admin.id });
  return card;
});
await make(ann, base({ title: 'Live chat on the checkout page' }), [{ rung: 1, result: 'Only 4% of checkout exits follow a help-page visit', verdict: 'fail', source: 'analytics' }]);
const dead = await make(ann, base({ title: 'Loyalty points for product reviews', status: 'inbox', next_test_date: '', kill_date: '' }));
await store.updateCard(dead.id, dead.version, { status: 'killed', body: { ...dead.body, verdict: { status: 'killed', reason: 'Review volume is not the problem; review quality is. Points would buy low-effort reviews.', revive: 'A test shows points raise review length', at: new Date().toISOString(), by: 'typed by Ann' } } });

// A conversation with an open question.
const conv = await store.createConversation(admin.id, { kind: 'new', model: 'claude-opus-5-5', effort: 'high', title: 'Free returns for members' });
await store.appendMessage(conv.id, 'user', [{ type: 'text', text: '<context>demo</context>' }, { type: 'text', text: 'Members should get free returns. It would make them buy more.' }], { turn: true });
await store.appendMessage(conv.id, 'assistant', [
  { type: 'tool_use', id: 't1', name: 'search_cards', input: { query: 'free returns members' } },
], { stopReason: 'tool_use' });
await store.appendMessage(conv.id, 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'No cards match.' }]);
const ask = { questions: [{ question: 'Who has the problem, in one sentence?', header: 'Who', multi_select: false, options: [
  { label: 'Members who hesitate on a second size', description: 'They order one size, fear the return fee, and order nothing', preview: '' },
  { label: 'All members, any product', description: 'Broader, harder to measure', preview: '' },
  { label: 'Members in one country only', description: 'Returns cost differs per country', preview: '' },
] }] };
await store.appendMessage(conv.id, 'assistant', [
  { type: 'text', text: 'No existing card covers this. Before the outcome: **who** has the problem? "It would make them buy more" is the outcome; I need the group whose behaviour changes.\n\nMy reading: members who would order two sizes but don\'t, because a return costs them €4.95.' },
  { type: 'tool_use', id: 't2', name: 'ask_user', input: ask },
], { stopReason: 'tool_use' });
await store.updateConversation(admin.id, conv.id, { status: 'waiting', pending: { tool_use_id: 't2', questions: ask.questions, results: [] }, context_date: today });
console.log(`seeded .data/pglite: 6 cards, 2 people, conversation /c/${conv.id}`);
await db.close();
