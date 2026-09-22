-- ClipFlow devices: soft delete + disconnect columns (2026-09-19)
alter table devices
  add column if not exists deleted_at timestamptz null,
  add column if not exists disconnected_at timestamptz null;

-- soft-deleted devices ko default queries se bahar rakhne ke liye index
create index if not exists devices_active_idx
  on devices (user_id) where deleted_at is null;
