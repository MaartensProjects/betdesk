// Jira Cloud REST API v3 with an API token (basic auth: account email + token).
// JIRA_BASE_URL is the site (https://your-site.atlassian.net) for a classic token, or
// https://api.atlassian.com/ex/jira/<cloudId> for a scoped token; JIRA_SITE_URL is used for browse links.

// status: the HTTP status when Jira answered; undefined when the request did not complete (then it may have).
export class JiraError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Jira {
  constructor(cfg, fetchFn = fetch) {
    this.cfg = cfg.jira;
    this.fetch = fetchFn;
  }

  async #call(method, path, body) {
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString('base64');
    const res = await this.fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const why = data?.errorMessages?.join(' ') || Object.entries(data?.errors || {}).map(([k, v]) => `${k}: ${v}`).join('; ') || text.slice(0, 200);
      throw new JiraError(`Jira answered ${res.status}${why ? `: ${why}` : ''}`, res.status);
    }
    return data;
  }

  browseUrl(key) {
    return `${this.cfg.siteUrl}/browse/${encodeURIComponent(key)}`;
  }

  async myself() {
    const me = await this.#call('GET', '/rest/api/3/myself');
    return { name: me.displayName, accountId: me.accountId };
  }

  async createIssue({ project, issueType, summary, description, labels = [] }) {
    const r = await this.#call('POST', '/rest/api/3/issue', {
      fields: { project: { key: project }, issuetype: { name: issueType || 'Story' }, summary: summary.slice(0, 250), description, labels },
    });
    return { key: r.key, url: this.browseUrl(r.key) };
  }

  // The newest issue in a project with a label (Betdesk labels each ticket bd-<card number>), or null.
  // openOnly: skip tickets in the done status category.
  async findByLabel(project, label, { openOnly = false } = {}) {
    const jql = `project = "${project.replace(/"/g, '')}" AND labels = "${label.replace(/"/g, '')}"${openOnly ? ' AND statusCategory != Done' : ''} ORDER BY created DESC`;
    const r = await this.#call('GET', `/rest/api/3/search/jql?${new URLSearchParams({ jql, fields: 'key', maxResults: '1' })}`);
    const key = r?.issues?.[0]?.key;
    return key ? { key, url: this.browseUrl(key) } : null;
  }

  // Status of an issue: its name and Jira's category (new, indeterminate, done).
  async status(key) {
    const r = await this.#call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,resolution`);
    return { name: r.fields?.status?.name || '', category: r.fields?.status?.statusCategory?.key || '', resolution: r.fields?.resolution?.name || '' };
  }
}
