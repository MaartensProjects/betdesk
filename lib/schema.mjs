// Database migrations. Each one is idempotent and runs once, in order, under an advisory lock,
// so two cold starts at the same moment never apply a migration twice.
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  domain text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'member',
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number serial UNIQUE,
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  status text NOT NULL,
  system text NOT NULL DEFAULT '',
  route text NOT NULL DEFAULT '',
  body jsonb NOT NULL,
  ladder jsonb NOT NULL,
  next_test_date date,
  kill_date date,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_owner ON cards(owner_id);
CREATE INDEX IF NOT EXISTS cards_status ON cards(status);

-- The card's evidence log and audit trail: every change, with who made it and how.
CREATE TABLE IF NOT EXISTS card_events (
  id bigserial PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id),
  source text NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  data jsonb
);
CREATE INDEX IF NOT EXISTS card_events_card ON card_events(card_id, at);

-- Conversations are private: every read and write is scoped to user_id.
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  card_id uuid REFERENCES cards(id),
  ref_card_id uuid REFERENCES cards(id),
  kind text NOT NULL,
  title text NOT NULL DEFAULT '',
  model text NOT NULL,
  effort text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'idle',
  running_since timestamptz,
  pending jsonb,
  context_date text NOT NULL DEFAULT '',
  draft text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content jsonb NOT NULL,
  usage jsonb,
  model text,
  turn boolean NOT NULL DEFAULT false,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  route text NOT NULL,
  target text NOT NULL,
  external_key text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  state text NOT NULL,
  detail text NOT NULL DEFAULT '',
  pr_url text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS handoffs_card ON handoffs(card_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
];
