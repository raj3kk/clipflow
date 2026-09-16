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
-- ACCESS MODEL:
--   RLS is enabled on every table with NO public policies. The anon key gets
--   nothing. All server/worker access goes through the service-role key, which
--   bypasses RLS.
-- ============================================================================

-- ---------------------------------------------------------------- campaigns --
create table if not exists campaigns (
  id text primary key,
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
  created_at timestamptz not null default now()
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
  campaign_id text not null references campaigns(id),
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
  created_at timestamptz not null default now()
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
  clip_id uuid references clips(id),
  campaign_id text references campaigns(id),
  instagram_url text not null default '',
  platform text not null default 'instagram',
  scheduled_for timestamptz,
  posted_at timestamptz,
  verify_status text not null default 'pending',
  verify_detail jsonb,
  created_at timestamptz not null default now()
);

-- Idempotent migration for projects created with the older posts shape
-- (posted_at not null + no scheduled_for column):
alter table posts add column if not exists scheduled_for timestamptz;
alter table posts alter column posted_at drop not null;

-- ------------------------------------------------------------- submissions --
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
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
  service text not null check (service in ('instagram','whop','gmail','content_rewards')),
  method text not null,
  label text,
  status text not null default 'needs_setup',
  last_verified timestamptz,
  secret_enc text,
  meta jsonb,
  created_at timestamptz not null default now(),
  unique (service, method)
);

-- ------------------------------------------------------------ interventions --
-- One-time human-in-the-loop hand-off (OTP codes, approvals). The raw value
-- is encrypted into value_enc on resolve and decrypted exactly once on
-- consume, then nulled. Never exposed in list/resolve responses or logs.
create table if not exists interventions (
  id uuid primary key default gen_random_uuid(),
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
  ts timestamptz not null default now(),
  actor text,
  event text not null,
  detail jsonb
);
create index if not exists activity_log_ts_idx on activity_log (ts desc);

-- ---------------------------------------------------------------- settings --
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  daily_target int not null default 4,
  spacing_hours numeric not null default 4,
  notify_email text,
  pause_on_block boolean not null default true,
  platforms jsonb not null default '{"instagram":true,"tiktok":false,"x":false,"youtube":false}',
  updated_at timestamptz not null default now()
);

insert into settings (id) values (1) on conflict (id) do nothing;

-- --------------------------------------------------------------------- RLS --
-- Service-role key bypasses RLS; anon gets nothing (no public policies).
alter table campaigns enable row level security;
alter table clips enable row level security;
alter table posts enable row level security;
alter table submissions enable row level security;
alter table connections enable row level security;
alter table interventions enable row level security;
alter table activity_log enable row level security;
alter table settings enable row level security;

-- ------------------------------------------------------------------ seeds --
-- Seed the three live campaigns
insert into campaigns (
  id, name, sponsor, payout_per_1k_usd, budget_remaining_usd,
  min_payout_usd, max_payout_usd, join_status,
  min_seconds, max_seconds, requirements, caption_template, hashtags,
  brief_url, campaign_url, joined, active
)
values
  ('perplexity-jre', 'Perplexity JRE Clipping — ClipFarm', 'Perplexity', 1.50, 14880,
   1.00, 1.50, 'joined',
   15, 60,
   '15–60s. Only listed brief moments. Perplexity clearly heard AND seen. No fake screens. Caption must include #PerplexityPartner. Minimal overlays, no watermark. Likes visible. ≥0.20% engagement. ≥40% views from US/UK/CA/AU. Keep live 30 days. No boosting/bots.',
   'Joe Rogan: "I just ask Perplexity" instead of sifting through Google searches 🤯 #PerplexityPartner',
   array['#PerplexityPartner'],
   'https://docs.google.com/document/d/1r3jFWtBrRbNdvp38w4qvcVK7vgu_6aK2GFQIS3pUBVk/edit?usp=sharing',
   'https://contentrewards.com/discover/00aa48e9-dc39-45f5-8c28-3d5821713826/preview',
   true, true),
  ('blizzard-blizzcon', 'Blizzard BlizzCon 2026 Trailer Clipping', 'Blizzard', 1.50, 52000,
   1.50, 1.50, 'joined',
   15, 60,
   'Official trailer-folder footage only. Caption #BlizzardPartner + franchise hashtag. Keep live 30 days.',
   'The Diablo V reveal is here 🔥 #BlizzardPartner #DiabloV',
   array['#BlizzardPartner','#DiabloV'],
   null, null, true, true),
  ('moonpay-cli', 'MoonPay CLI Clipping', 'MoonPay', 1.50, null,
   null, null, 'joined',
   15, 60,
   'Explain what MoonPay CLI does. Tag @moonpay in caption.',
   'What is MoonPay CLI? Ivan Soto-Wright explains how AI agents can transact with one line of code. @moonpay',
   array[]::text[],
   null, null, true, true)
on conflict (id) do nothing;

-- Public bucket for rendered clips + preview frames
insert into storage.buckets (id, name, public)
values ('clips', 'clips', true)
on conflict (id) do nothing;

-- Allow public read; writes go through the service-role key (server/worker only)
drop policy if exists "public read clips" on storage.objects;
create policy "public read clips" on storage.objects
  for select using (bucket_id = 'clips');
