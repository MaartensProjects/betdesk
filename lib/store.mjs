// Every database read and write. Conversation functions always take the user id, so one person can never
// read another person's conversation: there is no query that selects a conversation by id alone.

const CARD_COLUMNS = `c.id, c.number, c.owner_id, c.title, c.status, c.system, c.route, c.body, c.ladder,
  c.next_test_date, c.kill_date, c.version, c.created_at, c.updated_at, u.name AS owner_name, u.email AS owner_email`;

const toCard = (r) =>
  r && {
    ...r,
    next_test_date: r.next_test_date ? String(r.next_test_date).slice(0, 10) : '',
    kill_date: r.kill_date ? String(r.kill_date).slice(0, 10) : '',
    ladder: r.ladder || [],
    body: r.body || {},
  };

export const DEFAULT_SETTINGS = {
  model: '', // chosen by an admin on the Settings page; no default, because it decides the cost
  effort: 'high',
  webSearch: false,
  handoffMode: 'auto', // auto: hand off as soon as the pre-dev rungs pass; approval: an admin presses Hand off
  wipLimit: 0, // cards in validation per person; 0 is no limit
  turnsPerUserPerDay: 0, // 0 is no limit
  systems: [], // [{ key, name, description, repo, jiraProject, jiraIssueType, agent }]
};

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- users ----------
  async upsertUser({ email, name, role, domain = '' }) {
    return this.db.one(
      `INSERT INTO users (email, name, role, domain, last_login_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, domain = EXCLUDED.domain, last_login_at = now()
       RETURNING *`,
      [email, name, role, domain],
    );
  }
  getUser(id) {
    return this.db.one('SELECT * FROM users WHERE id = $1', [id]);
  }
  listUsers() {
    return this.db.query('SELECT id, email, name, role, disabled, last_login_at FROM users ORDER BY name');
  }
  setDisabled(id, disabled) {
    return this.db.one('UPDATE users SET disabled = $2 WHERE id = $1 RETURNING *', [id, disabled]);
  }

  // ---------- settings ----------
  async settings() {
    const rows = await this.db.query('SELECT key, value FROM settings');
    const out = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (Object.hasOwn(DEFAULT_SETTINGS, r.key)) out[r.key] = r.value;
    return out;
  }
  setSetting(key, value, userId) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`unknown setting ${key}`);
    return this.db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), userId],
    );
  }

  // ---------- cards ----------
  async createCard(ownerId, row) {
    const r = await this.db.one(
      `INSERT INTO cards (owner_id, title, status, system, route, body, ladder, next_test_date, kill_date)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING id`,
      [ownerId, row.title, row.status, row.system, row.route, JSON.stringify(row.body), JSON.stringify(row.ladder), row.next_test_date, row.kill_date],
    );
    return this.card(r.id);
  }
  async card(id) {
    return toCard(await this.db.one(`SELECT ${CARD_COLUMNS} FROM cards c JOIN users u ON u.id = c.owner_id WHERE c.id = $1`, [id]));
  }
  async cardByNumber(number) {
    return toCard(await this.db.one(`SELECT ${CARD_COLUMNS} FROM cards c JOIN users u ON u.id = c.owner_id WHERE c.number = $1`, [number]));
  }
  async cards() {
    return (await this.db.query(`SELECT ${CARD_COLUMNS} FROM cards c JOIN users u ON u.id = c.owner_id ORDER BY c.updated_at DESC`)).map(toCard);
  }
  // Optimistic update: returns null when someone else saved the card in between.
  async updateCard(id, version, patch) {
    const sets = [];
    const params = [id, version];
    for (const [k, v] of Object.entries(patch)) {
      if (!['title', 'status', 'system', 'route', 'body', 'ladder', 'next_test_date', 'kill_date'].includes(k)) throw new Error(`bad card field ${k}`);
      params.push(k === 'body' || k === 'ladder' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}${k === 'body' || k === 'ladder' ? '::jsonb' : ''}`);
    }
    const r = await this.db.one(`UPDATE cards SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING id`, params);
    return r ? this.card(r.id) : null;
  }
  async countInValidation(ownerId) {
    return Number((await this.db.one(`SELECT count(*)::int AS n FROM cards WHERE owner_id = $1 AND status = 'in validation'`, [ownerId])).n);
  }
  addEvent(cardId, { actorId = null, source, kind, text, data = null }) {
    return this.db.query('INSERT INTO card_events (card_id, actor_id, source, kind, text, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [cardId, actorId, source, kind, text, data ? JSON.stringify(data) : null]);
  }
  events(cardId) {
    return this.db.query('SELECT at, source, kind, text FROM card_events WHERE card_id = $1 ORDER BY at, id', [cardId]);
  }
  // Cards for the interview's search tool: title, problem and verdicts, never conversations.
  async searchCards(q, limit = 12) {
    const words = String(q || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2).slice(0, 8);
    const all = await this.cards();
    const score = (c) => {
      const hay = `${c.title} ${c.system} ${JSON.stringify(c.body.problem || {})} ${JSON.stringify(c.body.outcome || {})}`.toLowerCase();
      return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    };
    const ranked = words.length ? all.map((c) => [score(c), c]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c) : all;
    return ranked.slice(0, limit);
  }
  async lastEventOfKind(cardId, kind) {
    return this.db.one('SELECT at, source, text FROM card_events WHERE card_id = $1 AND kind = $2 ORDER BY at DESC, id DESC LIMIT 1', [cardId, kind]);
  }

  // ---------- conversations (always scoped to the user) ----------
  // cardId: the card this conversation writes (refine). refCardId: the card it is about (refine, retest).
  // draft: the first message, kept on the server (never in a URL) until the page sends it.
  createConversation(userId, { kind, cardId = null, refCardId = null, title = '', model, effort = '', draft = '' }) {
    return this.db.one('INSERT INTO conversations (user_id, card_id, ref_card_id, kind, title, model, effort, draft) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [userId, cardId, refCardId, kind, title, model, effort, draft]);
  }
  conversation(userId, id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
    return this.db.one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  }
  conversations(userId) {
    return this.db.query(
      `SELECT v.*, c.number AS card_number, c.title AS card_title FROM conversations v LEFT JOIN cards c ON c.id = v.card_id
       WHERE v.user_id = $1 ORDER BY v.updated_at DESC LIMIT 100`,
      [userId],
    );
  }
  conversationForCard(userId, cardId) {
    return this.db.one('SELECT * FROM conversations WHERE user_id = $1 AND card_id = $2 ORDER BY updated_at DESC LIMIT 1', [userId, cardId]);
  }
  updateConversation(userId, id, patch) {
    const sets = [];
    const params = [id, userId];
    for (const [k, v] of Object.entries(patch)) {
      if (!['title', 'card_id', 'status', 'pending', 'running_since', 'context_date', 'draft'].includes(k)) throw new Error(`bad conversation field ${k}`);
      params.push(k === 'pending' && v !== null ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}${k === 'pending' ? '::jsonb' : ''}`);
    }
    return this.db.one(`UPDATE conversations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`, params);
  }
  // Claims the conversation for one turn. A turn that has run for more than staleSeconds was cut off
  // (the function hit its time limit: 300 seconds on Vercel) and may be taken over.
  async claimTurn(userId, id, staleSeconds = 330) {
    const r = await this.db.one(
      `UPDATE conversations SET status = 'running', running_since = now(), updated_at = now()
       WHERE id = $1 AND user_id = $2 AND (status <> 'running' OR running_since < now() - ($3::int * interval '1 second'))
       RETURNING *`,
      [id, userId, staleSeconds],
    );
    return r;
  }
  // turn: true for the message a person sent (typed text or answers), which starts a turn.
  appendMessage(conversationId, role, content, { usage = null, model = null, turn = false, stopReason = null } = {}) {
    return this.db.one('INSERT INTO messages (conversation_id, role, content, usage, model, turn, stop_reason) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7) RETURNING id', [
      conversationId,
      role,
      JSON.stringify(content),
      usage ? JSON.stringify(usage) : null,
      model,
      turn,
      stopReason,
    ]);
  }
  messages(conversationId) {
    return this.db.query('SELECT id, role, content, stop_reason, created_at FROM messages WHERE conversation_id = $1 ORDER BY id', [conversationId]);
  }
  // Turns this person started since the given moment: messages they typed or answers they gave.
  async turnsSince(userId, sinceIso) {
    const r = await this.db.one(
      `SELECT count(*)::int AS n FROM messages m JOIN conversations v ON v.id = m.conversation_id
       WHERE v.user_id = $1 AND m.turn AND m.created_at >= $2`,
      [userId, sinceIso],
    );
    return Number(r.n);
  }
  // Token use per model since a moment, for the Settings page. Counts only; prices change, so none are shown.
  usageSince(sinceIso) {
    return this.db.query(
      `SELECT model, count(*)::int AS calls,
              coalesce(sum((usage->>'input_tokens')::bigint), 0)::bigint AS input,
              coalesce(sum((usage->>'output_tokens')::bigint), 0)::bigint AS output,
              coalesce(sum((usage->>'cache_read_input_tokens')::bigint), 0)::bigint AS cache_read,
              coalesce(sum((usage->>'cache_creation_input_tokens')::bigint), 0)::bigint AS cache_write
       FROM messages WHERE role = 'assistant' AND usage IS NOT NULL AND created_at >= $1 GROUP BY model ORDER BY model`,
      [sinceIso],
    );
  }

  // ---------- handoffs ----------
  createHandoff(cardId, { route, target, externalKey = '', url = '', state, detail = '', error = '', createdBy = null }) {
    return this.db.one(
      `INSERT INTO handoffs (card_id, route, target, external_key, url, state, detail, error, created_by, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING *`,
      [cardId, route, target, externalKey, url, state, detail, error, createdBy],
    );
  }
  latestHandoff(cardId) {
    return this.db.one('SELECT * FROM handoffs WHERE card_id = $1 ORDER BY created_at DESC LIMIT 1', [cardId]);
  }
  async latestHandoffs() {
    const rows = await this.db.query('SELECT DISTINCT ON (card_id) * FROM handoffs ORDER BY card_id, created_at DESC');
    return new Map(rows.map((r) => [r.card_id, r]));
  }
  // fromState: only update when the handoff is still in that state (null: any state). Returns null when another
  // check got there first, so a transition is logged once.
  updateHandoff(id, patch, fromState = null) {
    const sets = [];
    const params = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (!['state', 'detail', 'pr_url', 'error', 'url', 'external_key'].includes(k)) throw new Error(`bad handoff field ${k}`);
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    let where = 'id = $1';
    if (fromState !== null) {
      params.push(fromState);
      where += ` AND state = $${params.length}`;
    }
    return this.db.one(`UPDATE handoffs SET ${sets.join(', ')}, checked_at = now() WHERE ${where} RETURNING *`, params);
  }
  // Handoffs whose work is not finished yet, oldest check first.
  openHandoffs(limit = 25) {
    return this.db.query(
      `SELECT h.* FROM handoffs h JOIN cards c ON c.id = h.card_id
       WHERE c.status = 'in dev' AND h.state NOT IN ('done', 'failed', 'closed', 'blocked')
       ORDER BY h.checked_at NULLS FIRST LIMIT $1`,
      [limit],
    );
  }
}
