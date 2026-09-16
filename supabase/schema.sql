-- ============================================================================
-- ClipFlow schema — idempotent. Safe to run multiple times in the Supabase
-- SQL editor (new project or existing project).
--
-- ENCRYPTION SCHEME (for columns marked "ENCRYPTED" below):
--   Secrets in connections.secret_enc and interventions.value_enc are encrypted
--   with AES-256-GCM using node:crypto (see lib/crypto.ts, server-only).
--   Key: process.env.CONNECTIONS_ENCRYPT_KEY — 64 hex chars (32 random bytes).
--   Payload format: base64(JSON.stringify({ iv, tag, data }))
--     iv   = 12-byte random initialization vector, hex-encoded
--     tag  = 16-byte GCM authentication tag, hex-encoded (integrity: any
--            tampering with the ciphertext makes decryption fail)
--     data = ciphertext, hex-encoded
--   Raw secret values are NEVER written to logs or returned in API responses.
--   One-time hand-off for the VM worker: POST /api/interventions (pending) ->
--   owner resolves (encrypts value) -> worker GETs .../consume once (decrypts,
--   returns, then NULLs value_enc and marks 'consumed').
--
-- ACCESS MODEL (multi-user):
--   Every table has user_id (Supabase Auth user). RLS has one per-user policy
--   ("own_rows": user_id = auth.uid()) as defense in depth; the app also
--   scopes every query by user_id in code via the service-role key, which
--   bypasses RLS. The anon key gets nothing.
-- ============================================================================

-- ---------------------------------------------------------------- campaigns --
-- Campaigns are unique per (user_id, id): two users may each track the same
-- Whop campaign slug independently.
create table if not exists campaigns (
  id text not null,
  user_id uuid,
  name text not null,
  sponsor text not null,
  payout_per_1k_usd numeric not null default 0,
  budget_remaining_usd numeric,
  min_seconds int not null default 15,
  max_seconds int not null default 60,
  requirements text not null default '',
  caption_template text not null default '',
  hashtags text[] not null default '{}',
  brief_url text,
  campaign_url text,
  joined boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- New campaign columns (idempotent)
alter table campaigns add column if not exists min_payout_usd numeric;
alter table campaigns add column if not exists max_payout_usd numeric;
alter table campaigns add column if not exists join_status text not null default 'not_joined';
alter table campaigns add column if not exists scout_score numeric;
alter table campaigns add column if not exists notes text;

-- ------------------------------------------------------------------- clips --
create table if not exists clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  campaign_id text not null,
  source_url text not null,
  start_sec numeric not null,
  end_sec numeric not null,
  hook_text text,
  caption text,
  status text not null default 'queued',
  video_url text,
  preview_urls text[],
  instagram_url text,
  posted_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  foreign key (user_id, campaign_id)
    references campaigns (user_id, id) on delete cascade
);

-- New clip columns (idempotent)
alter table clips add column if not exists qa_result jsonb;
alter table clips add column if not exists scheduled_for timestamptz;
alter table clips add column if not exists brief_check jsonb;
alter table clips add column if not exists verification jsonb;

-- Extend status check to include 'scheduled' (drop + re-add is idempotent)
alter table clips drop constraint if exists clips_status_check;
alter table clips add constraint clips_status_check
  check (status in (
    'queued','rendering','preview','approved','scheduled',
    'posting','posted','submitted','failed'
  ));

-- ------------------------------------------------------------------- posts --
-- One row per Instagram post (scheduled or actually posted). scheduled_for is
-- the planned time (set by POST /api/clips/[id]/post); posted_at stays NULL
-- until the post really goes live, when the worker fills instagram_url +
-- posted_at (PATCH /api/posts/[id]).
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  clip_id uuid references clips(id),
  campaign_id text,
  instagram_url text not null default '',
  platform text not null default 'instagram',
  scheduled_for timestamptz,
  posted_at timestamptz,
  verify_status text not null default 'pending',
  verify_detail jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, campaign_id)
    references campaigns (user_id, id) on delete cascade
);

-- Idempotent migration for projects created with the older posts shape
-- (posted_at not null + no scheduled_for column):
alter table posts add column if not exists scheduled_for timestamptz;
alter table posts alter column posted_at drop not null;

-- ------------------------------------------------------------- submissions --
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  clip_id uuid not null references clips(id),
  instagram_url text not null,
  whop_status text not null default 'submitted',
  submitted_at timestamptz,
  views bigint,
  earnings_usd numeric,
  created_at timestamptz not null default now()
);

-- New submission columns (idempotent)
alter table submissions add column if not exists post_id uuid references posts(id);
alter table submissions add column if not exists keep_live_until date;

-- ------------------------------------------------------------- connections --
-- ENCRYPTED: secret_enc holds AES-256-GCM ciphertext (see header comment).
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  service text not null check (service in ('instagram','whop','gmail','content_rewards')),
  method text not null,
  label text,
  status text not null default 'needs_setup',
  last_verified timestamptz,
  secret_enc text,
  meta jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, service, method)
);

-- ------------------------------------------------------------ interventions --
-- One-time human-in-the-loop hand-off (OTP codes, approvals). The raw value
-- is encrypted into value_enc on resolve and decrypted exactly once on
-- consume, then nulled. Never exposed in list/resolve responses or logs.
create table if not exists interventions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  kind text not null,
  clip_id uuid references clips(id),
  question text not null,
  detail jsonb,
  status text not null default 'pending'
    check (status in ('pending','resolved','consumed','expired')),
  email_sent_at timestamptz,
  value_enc text,
  resolved_at timestamptz,
  resolved_via text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ activity_log --
create table if not exists activity_log (
  id bigserial primary key,
  user_id uuid,
  ts timestamptz not null default now(),
  actor text,
  event text not null,
  detail jsonb
);
create index if not exists activity_log_ts_idx on activity_log (ts desc);

-- ---------------------------------------------------------------- settings --
-- One row per user, keyed by the Supabase Auth user id. Created on first use.
create table if not exists settings (
  user_id uuid primary key,
  daily_target int not null default 4,
  spacing_hours numeric not null default 4,
  notify_email text,
  pause_on_block boolean not null default true,
  platforms jsonb not null default '{"instagram":true,"tiktok":false,"x":false,"youtube":false}',
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------- RLS --
-- Service-role key bypasses RLS; anon gets nothing except the per-user
-- "own_rows" policy below (defense in depth — the app also scopes every
-- query by user_id in code).
alter table campaigns enable row level security;
alter table clips enable row level security;
alter table posts enable row level security;
alter table submissions enable row level security;
alter table connections enable row level security;
alter table interventions enable row level security;
alter table activity_log enable row level security;
alter table settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','clips','posts','submissions',
    'connections','interventions','activity_log','settings'
  ] loop
    execute format('drop policy if exists own_rows on %I', t);
    execute format(
      'create policy own_rows on %I for all to authenticated ' ||
      'using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t
    );
  end loop;
end $$;

-- ------------------------------------------- multi-user convergence (idempotent) --
-- Brings databases created with the older single-user shape up to the
-- multi-user shape. No-ops on fresh installs (columns/constraints already
-- exist with the right shape) and on already-migrated projects.
alter table campaigns    add column if not exists user_id uuid;
alter table clips        add column if not exists user_id uuid;
alter table posts        add column if not exists user_id uuid;
alter table submissions  add column if not exists user_id uuid;
alter table connections  add column if not exists user_id uuid;
alter table interventions add column if not exists user_id uuid;
alter table activity_log add column if not exists user_id uuid;
alter table settings     add column if not exists user_id uuid;

create index if not exists campaigns_user_idx    on campaigns (user_id);
create index if not exists clips_user_idx        on clips (user_id);
create index if not exists posts_user_idx        on posts (user_id);
create index if not exists submissions_user_idx  on submissions (user_id);
create index if not exists connections_user_idx  on connections (user_id);
create index if not exists interventions_user_idx on interventions (user_id);
create index if not exists activity_log_user_idx  on activity_log (user_id);

-- connections: unique per (user, service, method)
alter table connections drop constraint if exists connections_service_method_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'connections_user_service_method_key'
  ) then
    alter table connections
      add constraint connections_user_service_method_key
      unique (user_id, service, method);
  end if;
end $$;

-- campaigns: unique per (user_id, id); composite FKs on clips/posts
alter table clips drop constraint if exists clips_campaign_id_fkey;
alter table posts drop constraint if exists posts_campaign_id_fkey;
alter table campaigns drop constraint if exists campaigns_pkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_user_id_pkey'
  ) then
    alter table campaigns
      add constraint campaigns_user_id_pkey primary key (user_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'clips_campaign_user_fk'
  ) then
    alter table clips
      add constraint clips_campaign_user_fk
      foreign key (user_id, campaign_id)
      references campaigns (user_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'posts_campaign_user_fk'
  ) then
    alter table posts
      add constraint posts_campaign_user_fk
      foreign key (user_id, campaign_id)
      references campaigns (user_id, id) on delete cascade;
  end if;
end $$;

-- settings: one row per user
delete from settings where user_id is null;
alter table settings drop constraint if exists settings_pkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'settings_user_pkey'
  ) then
    alter table settings add constraint settings_user_pkey primary key (user_id);
  end if;
end $$;

-- ------------------------------------------------------------------ seeds --
-- No demo seed data. Real users add their own campaigns through the UI.
-- (Older installs had three demo campaigns; the multi-user migration removed
-- them. This keeps fresh installs honest from the start.)

-- Public bucket for rendered clips + preview frames
insert into storage.buckets (id, name, public)
values ('clips', 'clips', true)
on conflict (id) do nothing;

-- Allow public read; writes go through the service-role key (server/worker only)
drop policy if exists "public read clips" on storage.objects;
create policy "public read clips" on storage.objects
  for select using (bucket_id = 'clips');
