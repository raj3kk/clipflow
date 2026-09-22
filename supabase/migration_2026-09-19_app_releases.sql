-- ============================================================================
-- AutoClip in-app auto-update: app_releases table (2026-09-19, round-6 Worker D)
-- Phone app GET /api/app/version se latest release check karta hai aur
-- apk_url se APK download karke self-update karta hai.
-- Idempotent: dobara chalane pe kuch nahi toot-ta.
-- ============================================================================

create table if not exists app_releases (
  id uuid primary key default gen_random_uuid(),
  version_code integer not null unique,
  version_name text not null,
  apk_url text not null,
  changelog text not null default '',
  force_update boolean not null default false,
  published_at timestamptz not null default now()
);

alter table app_releases enable row level security;

-- Public read: app BINA login /api/app/version se latest release padhe.
-- Write ke liye koi policy nahi -> sirf service_role (admin API) likh sakta hai.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_releases'
      and policyname = 'public read app_releases'
  ) then
    create policy "public read app_releases"
      on app_releases for select
      using (true);
  end if;
end $$;

create index if not exists app_releases_version_code_idx
  on app_releases (version_code desc);
