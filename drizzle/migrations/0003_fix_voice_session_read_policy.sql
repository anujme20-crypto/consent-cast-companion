-- The old SELECT/UPDATE policies called is_session_participant(id), which looks the
-- row up by id. During INSERT ... RETURNING (how the admin app creates a call and
-- needs its id back) the brand-new row is not yet visible to that lookup, so every
-- admin-side call start failed with RLS 42501. Replace both policies with direct
-- ownership checks that do not re-read the same table row.

drop policy "participants read sessions" on public.voice_sessions;
drop policy "participants update sessions" on public.voice_sessions;

create policy "participants read sessions"
  on public.voice_sessions
  for select
  to authenticated
  using (
    admin_id = auth.uid()
    or exists (
      select 1 from public.devices d
      where d.id = voice_sessions.device_id
        and d.user_id = auth.uid()
    )
  );

create policy "participants update sessions"
  on public.voice_sessions
  for update
  to authenticated
  using (
    admin_id = auth.uid()
    or exists (
      select 1 from public.devices d
      where d.id = voice_sessions.device_id
        and d.user_id = auth.uid()
    )
  )
  with check (
    admin_id = auth.uid()
    or exists (
      select 1 from public.devices d
      where d.id = voice_sessions.device_id
        and d.user_id = auth.uid()
    )
  );
