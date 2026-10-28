alter table public.devices add column token uuid not null default gen_random_uuid();
comment on column public.devices.token is 'Secret token issued at pairing; authenticates target-phone calls to /api/public/device/*. Re-pairing rotates it.';
alter table public.devices replica identity full;
alter publication supabase_realtime add table public.devices;