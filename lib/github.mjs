// GitHub REST API with a token that can write issues in the systems' repositories. The coding agent itself is the
// Claude Code GitHub Action in each repository (templates/github/betdesk-agent.yml): it starts when this app
// labels an issue, and opens a pull request that closes the issue.

// status: the HTTP status when GitHub answered; undefined when the request did not complete (then it may have).
export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The branch the agent workflow (templates/github/betdesk-agent.yml) pushes for an issue.
export const agentBranch = (number) => `betdesk/issue-${number}`;
// A hidden line in each issue body, so a later attempt finds the issue instead of creating a second one.
export const cardMarker = (cardId) => `<!-- betdesk:card=${cardId} -->`;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const validRepo = (s) => REPO.test(String(s || ''));

export class GitHub {
  constructor(cfg, fetchFn = fetch) {
    this.cfg = cfg.github;
    this.fetch = fetchFn;
  }

  async #call(method, path, body) {
    const res = await this.fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'betdesk',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}${data?.message ? `: ${data.message}` : ''}`, res.status);
    return data;
  }

  // What the token may do in a repository.
  async repoAccess(repo) {
    if (!validRepo(repo)) throw new GitHubError(`"${repo}" is not owner/name`);
    const r = await this.#call('GET', `/repos/${repo}`);
    return { fullName: r.full_name, push: Boolean(r.permissions?.push), defaultBranch: r.default_branch };
  }

  async createIssue(repo, { title, body, labels = [] }) {
    if (!validRepo(repo)) throw new GitHubError(`"${repo}" is not owner/name`);
    const r = await this.#call('POST', `/repos/${repo}/issues`, { title: title.slice(0, 250), body, labels });
    return { number: r.number, url: r.html_url };
  }

  // An issue with the label whose body holds the marker, updated since the given moment, or null.
  async findIssue(repo, { label, marker, since, state = 'all' }) {
    if (!validRepo(repo)) throw new GitHubError(`"${repo}" is not owner/name`);
    const q = new URLSearchParams({ labels: label, state, per_page: '100', ...(since ? { since } : {}) });
    const list = await this.#call('GET', `/repos/${repo}/issues?${q}`);
    const hit = (list || []).find((i) => !i.pull_request && String(i.body || '').includes(marker));
    return hit ? { number: hit.number, url: hit.html_url } : null;
  }

  // The issue's state, and the agent's own pull requests for it: same repository, the agent's branch.
  // A pull request elsewhere that merely mentions the issue does not count.
  async issueState(repo, number) {
    const [owner] = repo.split('/');
    const issue = await this.#call('GET', `/repos/${repo}/issues/${number}`);
    const pulls = await this.#call('GET', `/repos/${repo}/pulls?${new URLSearchParams({ state: 'all', head: `${owner}:${agentBranch(number)}`, per_page: '10' })}`);
    return {
      state: issue.state,
      stateReason: issue.state_reason || '',
      pulls: (pulls || []).map((p) => ({ url: p.html_url, state: p.state, merged: Boolean(p.merged_at), number: p.number })),
    };
  }
}
