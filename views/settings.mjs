// Admin settings: the Claude model and effort, handoff rules, the systems with their repository and Jira project,
// the integrations' status, token use, and who has signed in.
import { e, page, header, warn, flash, csrfField, postButton } from './html.mjs';
import { jiraConfigured, githubConfigured } from '../lib/config.mjs';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function systemFieldset(s, i) {
  const v = (k) => e(s?.[k] ?? '');
  const summary = s ? `<b>${e(s.name || s.key)}</b> <span class="opt">${e(s.key)}${s.repo ? ` · ${e(s.repo)}` : ''}${s.jiraProject ? ` · Jira ${e(s.jiraProject)}` : ''} · agent ${s.agent ? 'on' : 'off'}</span>` : '<b>Add a system</b>';
  return `<details class="sys"><summary>${summary}</summary><fieldset class="system"><div class="grid2">
<label>Key <span class="opt">short, lowercase; Claude uses it</span><input name="s${i}_key" value="${v('key')}" maxlength="40" pattern="[a-z0-9-]*"></label>
<label>Name<input name="s${i}_name" value="${v('name')}" maxlength="80"></label>
<label>GitHub repository <span class="opt">owner/name, for the coding agent</span><input name="s${i}_repo" value="${v('repo')}" maxlength="140"></label>
<label>Jira project key<input name="s${i}_jiraProject" value="${v('jiraProject')}" maxlength="20"></label>
<label>Jira issue type<input name="s${i}_jiraIssueType" value="${v('jiraIssueType') || (s ? '' : 'Story')}" maxlength="40"></label>
<label class="choice"><input type="checkbox" name="s${i}_agent" value="1"${s?.agent ? ' checked' : ''}> The coding agent may work in this repository</label>
</div><label>What it is <span class="opt">one line for Claude</span><input name="s${i}_description" value="${v('description')}" maxlength="300"></label>${s ? `<label class="choice"><input type="checkbox" name="s${i}_remove" value="1"> Remove this system</label>` : ''}</fieldset></details>`;
}

export function renderSettings(ctx) {
  const { cfg, user, token, settings, models, usage, users, checks = {} } = ctx;
  let body = header('Settings', 'Admins only. Changes apply to new conversations and the next handoff.');
  body += `<main>${flash(ctx.msg)}${ctx.error ? warn(e(ctx.error)) : ''}`;

  const known = models.some((m) => m.id === settings.model);
  const modelField = models.length
    ? `<select id="model" name="model" required>${settings.model ? '' : '<option value="" selected disabled>Choose a model</option>'}${!known && settings.model ? `<option value="${e(settings.model)}" selected>${e(settings.model)}</option>` : ''}${models.map((m) => `<option value="${e(m.id)}"${m.id === settings.model ? ' selected' : ''}>${e(m.name)} (${e(m.id)})</option>`).join('')}</select>`
    : `<input id="model" name="model" value="${e(settings.model)}" placeholder="a model id from the Anthropic docs" required>`;
  body += `<form method="post" action="/settings" class="stack">${csrfField(token)}
<section><h2>Claude</h2>
${settings.model ? '' : warn('No model is chosen yet, so no conversation can start. The model and effort decide the cost of each conversation; see the Anthropic pricing page.', '<a class="btn" href="https://www.anthropic.com/pricing" rel="noreferrer">Pricing</a>')}
<label for="model">Model for new conversations</label>${modelField}
<label for="effort">Effort <span class="opt">higher is more thorough and uses more tokens</span></label><select id="effort" name="effort">${EFFORTS.map((x) => `<option${x === settings.effort ? ' selected' : ''}>${x}</option>`).join('')}</select>
<label class="choice"><input type="checkbox" name="webSearch" value="1"${settings.webSearch ? ' checked' : ''}> Claude may search the web for sources <span class="opt">billed per search on top of tokens</span></label>
<label for="turns">Turns per person per day <span class="opt">0 is no limit</span></label><input id="turns" type="number" min="0" max="1000" name="turnsPerUserPerDay" value="${Number(settings.turnsPerUserPerDay) || 0}">
</section>
<section><h2>Handoff</h2>
<label class="choice"><input type="radio" name="handoffMode" value="auto"${settings.handoffMode !== 'approval' ? ' checked' : ''}> Automatic: a card goes to the agent or Jira as soon as every rung before the build has passed</label>
<label class="choice"><input type="radio" name="handoffMode" value="approval"${settings.handoffMode === 'approval' ? ' checked' : ''}> An admin approves each handoff on the board</label>
<label for="wip">Cards in validation per person <span class="opt">0 is no limit</span></label><input id="wip" type="number" min="0" max="50" name="wipLimit" value="${Number(settings.wipLimit) || 0}">
</section>
<section><h2>Systems</h2><p class="fine">The webshop and its supporting systems. A card names one; its handoff goes to that system's repository (coding agent) or Jira project. The repository needs the workflow in templates/github/betdesk-agent.yml.</p>
${settings.systems.map((s, i) => systemFieldset(s, i)).join('')}${systemFieldset(null, settings.systems.length)}
<input type="hidden" name="systemCount" value="${settings.systems.length + 1}">
</section>
<button class="btn big" type="submit">Save settings</button></form>`;

  body += '<section><h2>Integrations</h2><ul class="log">';
  body += `<li>Anthropic API key: ${cfg.anthropicApiKey ? '<span class="ok">set</span>' : '<span class="bad">missing: set ANTHROPIC_API_KEY</span>'}</li>`;
  body += `<li>Jira: ${jiraConfigured(cfg) ? `<span class="ok">configured</span> (${e(cfg.jira.siteUrl)}) ${postButton('/settings/test-jira', 'Test', token, {}, 'btn ghost small')}${checks.jira ? `<span class="meta">${e(checks.jira)}</span>` : ''}` : '<span class="bad">not configured: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN</span>'}</li>`;
  body += `<li>GitHub (coding agent): ${githubConfigured(cfg) ? `<span class="ok">token set</span>, label <code>${e(cfg.github.label)}</code> ${settings.systems.filter((s) => s.repo).map((s) => postButton('/settings/test-github', `Test ${s.repo}`, token, { repo: s.repo }, 'btn ghost small')).join(' ')}${checks.github ? `<span class="meta">${e(checks.github)}</span>` : ''}` : '<span class="bad">not configured: set GITHUB_TOKEN</span>'}</li>`;
  body += `<li>Status checks: ${cfg.cronSecret ? '<span class="ok">daily cron protected by CRON_SECRET</span>' : '<span class="bad">CRON_SECRET is not set; the daily status check is refused</span>'}; the board also checks open handoffs when it is opened.</li>`;
  body += '</ul></section>';

  body += `<section><h2>Token use this month</h2>${usage.length ? `<div class="scroll"><table class="usage"><thead><tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead><tbody>${usage.map((u) => `<tr><td>${e(u.model)}</td><td>${u.calls}</td><td>${Number(u.input).toLocaleString('en')}</td><td>${Number(u.output).toLocaleString('en')}</td><td>${Number(u.cache_read).toLocaleString('en')}</td><td>${Number(u.cache_write).toLocaleString('en')}</td></tr>`).join('')}</tbody></table></div><p class="fine">Counted by this app from the API's usage fields; the bill is in the Anthropic Console.</p>` : '<p class="sub">No calls yet this month.</p>'}</section>`;

  body += `<section><h2>People</h2><ul class="log">${users
    .map((u) => `<li>${e(u.name || u.email)} <span class="opt">${e(u.email)} · ${e(u.role)}${u.disabled ? ' · disabled' : ''}</span>${u.id !== user.id ? postButton('/settings/user', u.disabled ? 'Enable' : 'Disable', token, { id: u.id, disabled: u.disabled ? '0' : '1' }, 'btn ghost small') : ''}</li>`)
    .join('')}</ul><p class="fine">Who may sign in is set by ALLOWED_DOMAINS, ALLOWED_EMAILS and ADMIN_EMAILS in the environment. Disabling someone here blocks them even when their domain is allowed.</p></section>`;
  body += '</main>';
  return page('Settings', body, { nav: 'settings', user, token, appName: cfg.appName });
}

// Reads the settings form. Returns { settings } or { error }.
export function parseSettingsForm(form, current) {
  const effort = EFFORTS.includes(form.get('effort')) ? form.get('effort') : current.effort;
  const model = String(form.get('model') || '').trim();
  if (model && !/^[a-z0-9][a-z0-9.\-@:]{2,80}$/i.test(model)) return { error: `"${model}" does not look like a model id.` };
  const int = (k, max) => Math.max(0, Math.min(max, Number.parseInt(form.get(k) || '0', 10) || 0));
  const systems = [];
  const count = Math.min(50, Number.parseInt(form.get('systemCount') || '0', 10) || 0);
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const g = (k) => String(form.get(`s${i}_${k}`) || '').trim();
    if (g('remove') || !g('key')) continue;
    const key = g('key').toLowerCase();
    if (!/^[a-z0-9-]{1,40}$/.test(key)) return { error: `System key "${key}" may only hold lowercase letters, digits and hyphens.` };
    if (seen.has(key)) return { error: `System key "${key}" is used twice.` };
    seen.add(key);
    const repo = g('repo');
    if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { error: `Repository "${repo}" must be owner/name.` };
    const jiraProject = g('jiraProject').toUpperCase();
    if (jiraProject && !/^[A-Z][A-Z0-9_]{0,19}$/.test(jiraProject)) return { error: `Jira project key "${jiraProject}" is not a project key.` };
    systems.push({ key, name: g('name') || key, description: g('description'), repo, jiraProject, jiraIssueType: g('jiraIssueType') || 'Story', agent: Boolean(g('agent')) && Boolean(repo) });
  }
  return {
    settings: {
      model,
      effort,
      webSearch: form.get('webSearch') === '1',
      handoffMode: form.get('handoffMode') === 'approval' ? 'approval' : 'auto',
      wipLimit: int('wipLimit', 50),
      turnsPerUserPerDay: int('turnsPerUserPerDay', 1000),
      systems,
    },
  };
}
