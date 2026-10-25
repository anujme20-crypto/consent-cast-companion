create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  created_at timestamptz not null default now()
);

create table public.admin_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  pairing_code text not null unique,
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active','revoked')),
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

create table public.voice_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  status text not null default 'ringing' check (status in ('ringing','accepted','declined','active','ended','failed')),
  started_at timestamptz not null default now(),
  accepted_at timestamptz,
  ended_at timestamptz,
  end_reason text
);

create table public.webrtc_signals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.voice_sessions(id) on delete cascade,
  sender_role text not null check (sender_role in ('admin','device')),
  kind text not null check (kind in ('offer','answer')),
  sdp text not null,
  created_at timestamptz not null default now()
);

create table public.webrtc_ice (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.voice_sessions(id) on delete cascade,
  sender_role text not null check (sender_role in ('admin','device')),
  candidate jsonb not null,
  created_at timestamptz not null default now()
);

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT ON public.admin_settings TO authenticated;
GRANT ALL ON public.admin_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO authenticated;
GRANT ALL ON public.devices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_sessions TO authenticated;
GRANT ALL ON public.voice_sessions TO service_role;
GRANT SELECT, INSERT ON public.webrtc_signals TO authenticated;
GRANT ALL ON public.webrtc_signals TO service_role;
GRANT SELECT, INSERT ON public.webrtc_ice TO authenticated;
GRANT ALL ON public.webrtc_ice TO service_role;

alter table public.profiles enable row level security;
alter table public.admin_settings enable row level security;
alter table public.devices enable row level security;
alter table public.voice_sessions enable row level security;
alter table public.webrtc_signals enable row level security;
alter table public.webrtc_ice enable row level security;

create or replace function public.is_session_participant(_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.voice_sessions s
    join public.devices d on d.id = s.device_id
    where s.id = _session_id
      and (s.admin_id = auth.uid() or d.user_id = auth.uid())
  )
$$;

create or replace function public.can_signal(_session_id uuid, _role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.voice_sessions s
    join public.devices d on d.id = s.device_id
    where s.id = _session_id
      and s.status in ('accepted','active')
      and d.status = 'active'
      and (
        (_role = 'admin' and s.admin_id = auth.uid())
        or (_role = 'device' and d.user_id = auth.uid())
      )
  )
$$;

create policy "users read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "users insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "admins read own settings" on public.admin_settings for select to authenticated using (user_id = auth.uid());

create policy "device participants read" on public.devices for select to authenticated using (admin_id = auth.uid() or user_id = auth.uid());
create policy "admins create devices" on public.devices for insert to authenticated with check (admin_id = auth.uid());
create policy "device participants update" on public.devices for update to authenticated using (admin_id = auth.uid() or user_id = auth.uid()) with check (admin_id = auth.uid() or user_id = auth.uid());
create policy "admins delete devices" on public.devices for delete to authenticated using (admin_id = auth.uid());

create policy "participants read sessions" on public.voice_sessions for select to authenticated using (public.is_session_participant(id));
create policy "admins create sessions" on public.voice_sessions for insert to authenticated with check (admin_id = auth.uid());
create policy "participants update sessions" on public.voice_sessions for update to authenticated using (public.is_session_participant(id)) with check (public.is_session_participant(id));
create policy "admins delete sessions" on public.voice_sessions for delete to authenticated using (admin_id = auth.uid());

create policy "participants read signals" on public.webrtc_signals for select to authenticated using (public.is_session_participant(session_id));
create policy "participants send signals" on public.webrtc_signals for insert to authenticated with check (public.can_signal(session_id, sender_role));
create policy "participants read ice" on public.webrtc_ice for select to authenticated using (public.is_session_participant(session_id));
create policy "participants send ice" on public.webrtc_ice for insert to authenticated with check (public.can_signal(session_id, sender_role));

alter table public.voice_sessions replica identity full;
alter table public.webrtc_signals replica identity full;
alter table public.webrtc_ice replica identity full;
alter publication supabase_realtime add table public.voice_sessions;
alter publication supabase_realtime add table public.webrtc_signals;
alter publication supabase_realtime add table public.webrtc_ice;