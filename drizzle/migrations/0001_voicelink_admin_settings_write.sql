GRANT UPDATE ON public.admin_settings TO authenticated;
create policy "admins create own settings" on public.admin_settings for insert to authenticated with check (user_id = auth.uid());
create policy "admins update own settings" on public.admin_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());