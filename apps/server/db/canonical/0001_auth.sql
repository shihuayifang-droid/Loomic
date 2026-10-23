-- HaHart canonical migration 0001 (ticket 42B, ADR-0001).
--
-- Self-contained: this file only ever touches the `hahart_auth` schema it
-- creates below. It references no Supabase object (no Supabase auth schema, no
-- `public.profiles`, no `storage`, no extensions) so it runs as-is on an empty
-- database, and it never joins the `supabase/migrations` chain — that chain
-- belongs to the retired baseline and is not applied to the new database.
--
-- Decisions encoded here (recorded on ticket 42B):
--   * refresh tokens are stored only as their sha256 hex digest (`refresh_hash`,
--     unique) — a leaked dump cannot mint sessions;
--   * every rotation creates a new row in the same `family_id`, so a replay of
--     an already rotated token can revoke the whole family at once;
--   * users start as `pending` and need administrator approval (`active`), or
--     they are `disabled`;
--   * `token_version` is bumped whenever the password changes, so every access
--     token minted before the change can be rejected in one step.
--
-- Apply with a single exec: all statements are idempotent-safe in the sense
-- that they run against a fresh schema; this is a create-only migration.

create schema if not exists hahart_auth;

create table hahart_auth.users (
  id uuid primary key,
  email text not null,
  display_name text,
  status text not null check (status in ('pending', 'active', 'disabled')) default 'pending',
  token_version integer not null default 0 check (token_version >= 0),
  must_change_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness: the same mailbox must never become two users,
-- whatever casing the caller used.
create unique index users_email_lower_key on hahart_auth.users (lower(email));

-- One credential row per user. `on delete cascade` keeps an orphan hash from
-- surviving its user.
create table hahart_auth.credentials (
  user_id uuid primary key references hahart_auth.users(id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

-- One row per issued refresh token. `refresh_hash` is the sha256 digest of the
-- token handed to the client; `family_id` groups a rotation chain so a replay
-- can revoke all of it; `replaced_by` links a rotated row to its successor.
create table hahart_auth.sessions (
  id uuid primary key,
  user_id uuid not null references hahart_auth.users(id) on delete cascade,
  family_id uuid not null,
  refresh_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz not null default now()
);

create index sessions_user_idx on hahart_auth.sessions (user_id);
create index sessions_family_idx on hahart_auth.sessions (family_id);

-- Login throttle bucket. `key` is the caller-supplied throttle key (per the
-- ticket: IP plus email); the index serves the "count within a window" query.
create table hahart_auth.login_attempts (
  key text not null,
  attempted_at timestamptz not null default now()
);

create index login_attempts_key_time_idx on hahart_auth.login_attempts (key, attempted_at);
