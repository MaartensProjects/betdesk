// Test helpers: an in-memory Postgres (PGlite), a configuration, a scripted Claude client and fake HTTP services.
import { pglite } from '../dev/pglite.mjs';
import { migrate } from '../lib/db.mjs';
import { Store } from '../lib/store.mjs';
import { loadConfig } from '../lib/config.mjs';

export async function freshStore() {
  const db = await pglite();
  await migrate(db);
  return new Store(db);
}

export function testConfig(env = {}) {
  return loadConfig({
    APP_URL: 'https://betdesk.test',
    SESSION_SECRET: 'x'.repeat(40),
    DATABASE_URL: 'pglite:',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    ALLOWED_DOMAINS: 'shop.example',
    ADMIN_EMAILS: 'admin@shop.example',
    ANTHROPIC_API_KEY: 'sk-test',
    JIRA_BASE_URL: 'https://shop.atlassian.net',
    JIRA_EMAIL: 'bot@shop.example',
    JIRA_API_TOKEN: 'jira-token',
    GITHUB_TOKEN: 'gh-token',
    CRON_SECRET: 'cron-secret',
    TIME_ZONE: 'Asia/Tokyo',
    ...env,
  });
}

export const SYSTEMS = [
  { key: 'web', name: 'Webshop front end', description: 'storefront', repo: 'shop/storefront', jiraProject: 'WEB', jiraIssueType: 'Story', agent: true },
  { key: 'erp', name: 'ERP', description: 'stock and orders', repo: '', jiraProject: 'ERP', jiraIssueType: 'Task', agent: false },
];

// A valid save_bet_card input; override parts per test.
export function cardInput(over = {}) {
  return {
    card_number: 0,
    title: 'Show shipping costs on the product page',
    system: 'web',
    problem: { who: 'Mobile shoppers', problem: 'They abandon checkout when shipping costs appear late', why_now: 'Abandonment rose last quarter' },
    outcome: { metric: 'Checkout conversion on mobile', target: '+0.3 percentage points', by_date: '2027-03-01', measured_by: 'Analytics funnel, read by the PO' },
    value: { estimate: 'About €4k a month of gross margin (owner estimate)', cost: 'Two dev days (owner estimate)' },
    riskiest_assumption: { kind: 'value', statement: 'Showing shipping earlier raises mobile conversion by at least 0.3 pp' },
    ladder: [
      { rung: 1, name: 'Desk check', test: 'Funnel data: where do mobile users drop?', pass_bar: 'At least 20% of drops happen on the shipping step', judge: 'PO', time_box: '2 hours', budget: '€0', build: false },
      { rung: 2, name: 'Customer evidence', test: 'Five customer calls', pass_bar: '3 of 5 name shipping cost surprise', judge: 'PO', time_box: '1 week', budget: '€0', build: false },
      { rung: 3, name: 'Build', test: 'Dev work', pass_bar: '', judge: '', time_box: '', budget: '', build: true },
    ],
    pass_bar_changes: [],
    status: 'in validation',
    next_test_date: '2026-10-23',
    kill_date: '2027-01-31',
    limits: { time: '2 hours a week', budget: '€0', kill_criterion: 'No rung passes by the kill date', displaces: 'nothing' },
    flags: { personal_data: 'no', payments: 'no', legal: 'no', notes: '' },
    delivery: { route: 'agent', reason: 'Small storefront change', acceptance_criteria: ['Shipping cost shows under the price on every product page'] },
    change_note: '',
    ...over,
  };
}

// A scripted Claude: each call to beta.messages.stream takes the next step. A step is a function (params) => message
// or a message object: { content, stop_reason }. Text blocks are streamed as deltas.
// Assertions inside a step are collected in .errors (the turn would otherwise swallow them); tests check it.
export function fakeClaude(steps) {
  const calls = [];
  const errors = [];
  return {
    calls,
    errors,
    beta: {
      messages: {
        stream(params) {
          calls.push(JSON.parse(JSON.stringify(params)));
          const step = steps.shift();
          if (!step) {
            errors.push(new Error('no scripted step left'));
            throw errors[errors.length - 1];
          }
          let msg;
          try {
            msg = typeof step === 'function' ? step(params) : step;
          } catch (e) {
            errors.push(e);
            throw e;
          }
          const message = { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: params.model, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn', ...msg };
          return {
            async *[Symbol.asyncIterator]() {
              for (const b of message.content) {
                if (b.type === 'text') yield { type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } };
              }
            },
            finalMessage: async () => message,
          };
        },
      },
    },
    models: { list: async function* () {} },
  };
}

export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

// The lookups a handoff does before it creates anything: nothing found.
export const NO_EXISTING = [
  [/api\.github\.com\/repos\/[^/]+\/[^/]+\/issues\?/, { reply: { body: [] } }],
  [/rest\/api\/3\/search\/jql/, { reply: { body: { issues: [] } } }],
];

// A fake fetch that answers by URL pattern and records every request.
export function fakeFetch(routes) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || 'GET', body: init.body ? (typeof init.body === 'string' ? init.body : String(init.body)) : '' });
    for (const [pattern, handler] of routes) {
      if (pattern.test(u) && (!handler.method || handler.method === (init.method || 'GET'))) {
        const r = typeof handler.reply === 'function' ? handler.reply(u, init) : handler.reply;
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ message: `no fake for ${u}` }), { status: 404 });
  };
  fn.requests = requests;
  return fn;
}
