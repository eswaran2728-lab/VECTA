-- Lets any authenticated user (e.g. an officer whose report submission needs to notify
-- admins) look up admin email addresses without needing SELECT access to other users'
-- profile rows. Same SECURITY DEFINER pattern as current_role_name()/current_station()
-- in 0002_rls.sql — bypasses RLS internally, but only ever exposes the ADMIN emails.

create or replace function get_admin_emails()
returns setof text as $$
  select email from profiles where role = 'ADMIN';
$$ language sql stable security definer set search_path = public;

revoke execute on function get_admin_emails() from anon, public;
grant execute on function get_admin_emails() to authenticated;
