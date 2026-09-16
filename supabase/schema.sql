-- ClipFlow schema — run once in the Supabase SQL editor (new project).
-- Creates tables + a public storage bucket for rendered clips.

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

create table if not exists clips (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null references campaigns(id),
  source_url text not null,
  start_sec numeric not null,
  end_sec numeric not null,
  hook_text text,
  caption text,
  status text not null default 'queued'
    check (status in ('queued','rendering','preview','approved','posting','posted','submitted','failed')),
  video_url text,
  preview_urls text[],
  instagram_url text,
  posted_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

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

-- Seed the three live campaigns
insert into campaigns (id, name, sponsor, payout_per_1k_usd, budget_remaining_usd, min_seconds, max_seconds, requirements, caption_template, hashtags, brief_url, campaign_url, joined, active)
values
  ('perplexity-jre', 'Perplexity JRE Clipping — ClipFarm', 'Perplexity', 1.50, 14880, 15, 60,
   '15–60s. Only listed brief moments. Perplexity clearly heard AND seen. No fake screens. Caption must include #PerplexityPartner. Minimal overlays, no watermark. Likes visible. ≥0.20% engagement. ≥40% views from US/UK/CA/AU. Keep live 30 days. No boosting/bots.',
   'Joe Rogan: "I just ask Perplexity" instead of sifting through Google searches 🤯 #PerplexityPartner',
   array['#PerplexityPartner'],
   'https://docs.google.com/document/d/1r3jFWtBrRbNdvp38w4qvcVK7vgu_6aK2GFQIS3pUBVk/edit?usp=sharing',
   'https://contentrewards.com/discover/00aa48e9-dc39-45f5-8c28-3d5821713826/preview',
   true, true),
  ('blizzard-blizzcon', 'Blizzard BlizzCon 2026 Trailer Clipping', 'Blizzard', 1.50, 52000, 15, 60,
   'Official trailer-folder footage only. Caption #BlizzardPartner + franchise hashtag. Keep live 30 days.',
   'The Diablo V reveal is here 🔥 #BlizzardPartner #DiabloV',
   array['#BlizzardPartner','#DiabloV'],
   null, null, true, true),
  ('moonpay-cli', 'MoonPay CLI Clipping', 'MoonPay', 1.50, null, 15, 60,
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
create policy "public read clips" on storage.objects
  for select using (bucket_id = 'clips');
