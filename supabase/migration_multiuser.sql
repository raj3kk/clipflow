-- ============================================================================
-- ClipFlow multi-user migration — idempotent.
-- Gives every table a user_id (Supabase Auth user), scopes RLS per user,
-- makes connections unique per (user, service, method), makes settings
-- per-user, and removes the old demo seed campaigns.
-- ============================================================================

-- 1. user_id on all 8 tables
alter table campaigns    add column if not exists user_id uuid;
alter table clips        add column if not exists user_id uuid;
alter table posts        add column if not exists user_id uuid;
alter table submissions  add column if not exists user_id uuid;
alter table connections  add column if not exists user_id uuid;
alter table interventions add column if not exists user_id uuid;
alter table activity_log add column if not exists user_id uuid;
alter table settings     add column if not exists user_id uuid;

-- Helpful indexes for per-user queries
create index if not exists campaigns_user_idx    on campaigns (user_id);
create index if not exists clips_user_idx        on clips (user_id);
create index if not exists posts_user_idx        on posts (user_id);
create index if not exists submissions_user_idx  on submissions (user_id);
create index if not exists connections_user_idx  on connections (user_id);
create index if not exists interventions_user_idx on interventions (user_id);
create index if not exists activity_log_user_idx  on activity_log (user_id);

-- 2. connections: unique per (user, service, method) instead of (service, method)
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

-- 3. settings: one row per user (was: single global row id=1)
alter table settings drop constraint if exists settings_id_check;
-- Drop the old global default row FIRST; each user gets their own row on first use.
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

-- 4. Remove old demo seed campaigns (flagged as demo data; real users add own)
delete from campaigns where id in ('perplexity-jre', 'blizzard-blizzcon', 'moonpay-cli');

-- 5. Per-user RLS policies (defense in depth; the app also scopes by user_id
--    in code via the service-role key. Service role bypasses RLS as before.)
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
