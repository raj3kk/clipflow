-- ============================================================================
-- ClipFlow agent-system migration — idempotent.
-- Agent memory (episodic/semantic/lessons/decisions), agent skills
-- (versioned specs + eval history), aur agent issues (failures + fixes).
-- RLS per-user (migration_multiuser.sql wala pattern); service role
-- RLS bypass karta hai, app code me user_id scope hota hai.
-- ============================================================================

-- 1. agent_memory — agent ki long-term memory (episodic, semantic,
--    skill lessons, brain decisions)
create table if not exists agent_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  agent_id text not null,
  kind text not null check (kind in ('episodic','semantic','skill_lesson','brain_decision')),
  key text not null,
  content jsonb not null default '{}',
  importance float not null default 0.5,
  created_at timestamptz default now(),
  expires_at timestamptz
);
-- Table pehle se ho to columns add kar do (idempotency ke liye)
alter table agent_memory add column if not exists user_id uuid;
alter table agent_memory add column if not exists agent_id text;
alter table agent_memory add column if not exists kind text;
alter table agent_memory add column if not exists key text;
alter table agent_memory add column if not exists content jsonb;
alter table agent_memory add column if not exists importance float;
alter table agent_memory add column if not exists created_at timestamptz;
alter table agent_memory add column if not exists expires_at timestamptz;
create index if not exists agent_memory_user_kind_idx   on agent_memory (user_id, kind);
create index if not exists agent_memory_user_agent_idx  on agent_memory (user_id, agent_id);
create index if not exists agent_memory_expires_idx     on agent_memory (expires_at);

-- 2. agent_skills — agent ke skills: versioned spec + mastery score
--    + eval history + review flag
create table if not exists agent_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  skill_key text not null,
  version int not null default 1,
  spec jsonb not null default '{}',
  mastery_score float not null default 0.5,
  eval_history jsonb not null default '[]',
  needs_review boolean not null default false,
  updated_at timestamptz default now(),
  unique (user_id, skill_key)
);
alter table agent_skills add column if not exists user_id uuid;
alter table agent_skills add column if not exists skill_key text;
alter table agent_skills add column if not exists version int;
alter table agent_skills add column if not exists spec jsonb;
alter table agent_skills add column if not exists mastery_score float;
alter table agent_skills add column if not exists eval_history jsonb;
alter table agent_skills add column if not exists needs_review boolean;
alter table agent_skills add column if not exists updated_at timestamptz;
create index if not exists agent_skills_user_idx on agent_skills (user_id);

-- 3. agent_issues — agent failures/issues: severity, title, context,
--    root-cause hypothesis, status lifecycle
create table if not exists agent_issues (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  agent_id text not null,
  severity text not null check (severity in ('low','medium','high')),
  title text not null,
  context jsonb not null default '{}',
  root_cause_hypothesis text,
  status text not null default 'open' check (status in ('open','investigating','resolved')),
  created_at timestamptz default now(),
  resolved_at timestamptz
);
alter table agent_issues add column if not exists user_id uuid;
alter table agent_issues add column if not exists agent_id text;
alter table agent_issues add column if not exists severity text;
alter table agent_issues add column if not exists title text;
alter table agent_issues add column if not exists context jsonb;
alter table agent_issues add column if not exists root_cause_hypothesis text;
alter table agent_issues add column if not exists status text;
alter table agent_issues add column if not exists created_at timestamptz;
alter table agent_issues add column if not exists resolved_at timestamptz;
create index if not exists agent_issues_user_status_idx on agent_issues (user_id, status);
create index if not exists agent_issues_severity_idx     on agent_issues (severity);

-- 4. RLS: per-user own_rows policy (same pattern as migration_multiuser.sql)
alter table agent_memory enable row level security;
alter table agent_skills enable row level security;
alter table agent_issues enable row level security;
do $$
declare t text;
begin
  foreach t in array array['agent_memory','agent_skills','agent_issues'] loop
    execute format('drop policy if exists own_rows on %I', t);
    execute format(
      'create policy own_rows on %I for all to authenticated ' ||
      'using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t
    );
  end loop;
end $$;
