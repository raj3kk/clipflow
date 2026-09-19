-- P0 heartbeat fix (2026-09-19): phone app execution ke dauraan heartbeat bhejta hai.
-- heartbeat_count: heartbeat route har call pe +1 (0 = purana app / kabhi heartbeat nahi aaya).
-- current_step: phone ka current automation step ("uploading", "submitting"...) — Live page pe dikhta hai.
alter table device_jobs
  add column if not exists heartbeat_count int not null default 0;
alter table device_jobs
  add column if not exists current_step text;
