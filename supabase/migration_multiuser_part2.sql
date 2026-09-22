-- ============================================================================
-- ClipFlow multi-user migration part 2 — idempotent.
-- Campaigns become unique per (user_id, id) instead of globally unique,
-- so two different users can each track the same Whop campaign slug.
-- Child FKs (clips, posts) become composite (user_id, campaign_id).
-- ============================================================================

-- 1. Drop the old single-column FKs that reference campaigns(id)
alter table clips drop constraint if exists clips_campaign_id_fkey;
alter table posts drop constraint if exists posts_campaign_id_fkey;

-- 2. Replace the global PK with a per-user composite PK
alter table campaigns drop constraint if exists campaigns_pkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_user_id_pkey'
  ) then
    alter table campaigns
      add constraint campaigns_user_id_pkey primary key (user_id, id);
  end if;
end $$;

-- 3. Composite FKs so a clip/post always belongs to its user's campaign row
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clips_campaign_user_fk'
  ) then
    alter table clips
      add constraint clips_campaign_user_fk
      foreign key (user_id, campaign_id)
      references campaigns (user_id, id)
      on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'posts_campaign_user_fk'
  ) then
    alter table posts
      add constraint posts_campaign_user_fk
      foreign key (user_id, campaign_id)
      references campaigns (user_id, id)
      on delete cascade;
  end if;
end $$;
