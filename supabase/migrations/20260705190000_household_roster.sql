-- Plan 16h follow-up — household_roster(): members WITH their emails.
--
-- household_members only stores (household_id, user_id, role); the email lives
-- in auth.users, which the browser client can't read (protected auth schema).
-- This security-definer RPC joins the two and returns the roster for the
-- CALLER'S household only (scoped by current_household), so the members list can
-- show a name/email instead of a bare role. No new data — just a read path.
create or replace function "public"."household_roster"()
    returns table ("user_id" "uuid", "role" "text", "email" "text")
    language "sql"
    security definer
    set "search_path" to ''
    as $$
  select m.user_id, m.role, u.email::text
  from public.household_members m
  join auth.users u on u.id = m.user_id
  where m.household_id = (select "private"."current_household"())
  order by (m.role = 'owner') desc, u.email;
$$;

alter function "public"."household_roster"() owner to "postgres";
grant execute on function "public"."household_roster"() to "authenticated";
