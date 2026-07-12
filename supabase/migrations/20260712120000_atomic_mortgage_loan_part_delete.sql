-- Plan 94 — Delete a mortgage loan part and its financial history atomically.
--
-- Product decision: deletion is a permanent cascade over the selected loan
-- part, its mortgage_payments, and its mortgage_rate_periods. There is no FK on
-- loan_part_id yet: legacy orphans must first be audited with
-- supabase/mortgage-orphan-preflight.sql before any future constraint is added.
--
-- SECURITY DEFINER is required so one function can perform the full transaction
-- without exposing partially-completed state. It therefore reproduces the RLS
-- household boundary explicitly on every statement, derives the household on
-- the server, pins search_path to empty, and schema-qualifies every object.

create or replace function "public"."delete_mortgage_loan_part"(
  "p_loan_part_id" "text"
) returns void
  language "plpgsql"
  security definer
  set "search_path" to ''
  as $$
declare
  "hid" "uuid" := (select "private"."current_household"());
begin
  if (select "auth"."uid"()) is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if "hid" is null then
    raise exception using
      errcode = '42501',
      message = 'no household';
  end if;

  -- Lock the parent before touching dependents. The household predicate gives
  -- missing ids and other-household ids the same non-disclosing response.
  perform 1
    from "public"."mortgage_loan_parts"
    where "household_id" = "hid" and "id" = "p_loan_part_id"
    for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'mortgage loan part not found';
  end if;

  delete from "public"."mortgage_payments"
    where "household_id" = "hid" and "loan_part_id" = "p_loan_part_id";

  delete from "public"."mortgage_rate_periods"
    where "household_id" = "hid" and "loan_part_id" = "p_loan_part_id";

  delete from "public"."mortgage_loan_parts"
    where "household_id" = "hid" and "id" = "p_loan_part_id";
end;
$$;

alter function "public"."delete_mortgage_loan_part"("text") owner to "postgres";
revoke all on function "public"."delete_mortgage_loan_part"("text") from public;
revoke all on function "public"."delete_mortgage_loan_part"("text") from anon;
grant execute on function "public"."delete_mortgage_loan_part"("text") to authenticated;
