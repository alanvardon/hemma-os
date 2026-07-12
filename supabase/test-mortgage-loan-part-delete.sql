-- SQL-level proof for Plan 94's SECURITY DEFINER deletion RPC.
--
-- Run the whole file against a local database after migrations. It creates two
-- fictional households, tests success, hostile-household isolation, and a
-- forced mid-operation failure, then rolls everything back. Success ends with
-- the ALL PASS notice and leaves no data behind.

begin;

do $$
declare
  uid_a uuid := gen_random_uuid();
  uid_b uuid := gen_random_uuid();
  hh_a uuid := gen_random_uuid();
  hh_b uuid := gen_random_uuid();
  cnt integer;
begin
  insert into auth.users (id, email, aud, role)
    values (uid_a, 'mortgage-a.test@example.com', 'authenticated', 'authenticated'),
           (uid_b, 'mortgage-b.test@example.com', 'authenticated', 'authenticated');
  insert into public.households (id, name)
    values (hh_a, 'Mortgage test A'), (hh_b, 'Mortgage test B');
  insert into public.household_members (household_id, user_id, role)
    values (hh_a, uid_a, 'owner'), (hh_b, uid_b, 'owner');

  insert into public.mortgage_loan_parts
    (id, household_id, label, loan_number, start_balance, start_date)
    values ('part-a', hh_a, 'A', 'A', 100000, '2026-01-01'),
           ('part-a-keep', hh_a, 'A keep', 'A2', 200000, '2026-01-01'),
           ('part-a-rollback', hh_a, 'A rollback', 'A3', 300000, '2026-01-01'),
           ('part-b', hh_b, 'B', 'B', 400000, '2026-01-01');
  insert into public.mortgage_payments
    (id, household_id, loan_part_id, date, amount)
    values ('pay-a', hh_a, 'part-a', '2026-02-01', 1000),
           ('pay-a-keep', hh_a, 'part-a-keep', '2026-02-01', 2000),
           ('pay-a-rollback', hh_a, 'part-a-rollback', '2026-02-01', 3000),
           ('pay-b', hh_b, 'part-b', '2026-02-01', 4000);
  insert into public.mortgage_rate_periods
    (id, household_id, loan_part_id, start_date, rate)
    values ('rate-a', hh_a, 'part-a', '2026-01-01', 3.1),
           ('rate-a-keep', hh_a, 'part-a-keep', '2026-01-01', 3.2),
           ('rate-a-rollback', hh_a, 'part-a-rollback', '2026-01-01', 3.3),
           ('rate-a-property', hh_a, null, '2026-01-01', 3.4),
           ('rate-b', hh_b, 'part-b', '2026-01-01', 3.5);

  -- An unauthenticated caller is rejected before any row lookup.
  perform set_config('request.jwt.claims', '{}'::text, true);
  begin
    perform public.delete_mortgage_loan_part('part-a');
    raise exception 'FAIL unauthenticated: deletion should be rejected';
  exception
    when insufficient_privilege then null;
  end;

  -- Household A cannot use B's id. The generic response does not reveal
  -- whether that id exists, and B's parent/history remain untouched.
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'email', 'mortgage-a.test@example.com')::text, true);
  begin
    perform public.delete_mortgage_loan_part('part-b');
    raise exception 'FAIL hostile household: deletion should be rejected';
  exception
    when no_data_found then null;
  end;
  select count(*) into cnt
    from public.mortgage_loan_parts where household_id = hh_b and id = 'part-b';
  if cnt <> 1 then raise exception 'FAIL hostile household: parent changed'; end if;
  select count(*) into cnt
    from public.mortgage_payments where household_id = hh_b and loan_part_id = 'part-b';
  if cnt <> 1 then raise exception 'FAIL hostile household: payment changed'; end if;
  select count(*) into cnt
    from public.mortgage_rate_periods where household_id = hh_b and loan_part_id = 'part-b';
  if cnt <> 1 then raise exception 'FAIL hostile household: rate period changed'; end if;

  -- Fail on the second dependent table. The payment delete executes first, so
  -- retaining all three rows proves PostgreSQL rolled the RPC back atomically.
  create function pg_temp.reject_rate_period_delete() returns trigger
    language plpgsql as $trigger$
  begin
    if old.id = 'rate-a-rollback' then
      raise exception 'forced rate-period failure';
    end if;
    return old;
  end;
  $trigger$;
  create trigger plan94_force_failure
    before delete on public.mortgage_rate_periods
    for each row execute function pg_temp.reject_rate_period_delete();

  begin
    perform public.delete_mortgage_loan_part('part-a-rollback');
    raise exception 'FAIL rollback: forced failure did not fire';
  exception
    when others then
      if sqlerrm not like '%forced rate-period failure%' then raise; end if;
  end;
  select count(*) into cnt from public.mortgage_loan_parts where id = 'part-a-rollback';
  if cnt <> 1 then raise exception 'FAIL rollback: parent was deleted'; end if;
  select count(*) into cnt from public.mortgage_payments where id = 'pay-a-rollback';
  if cnt <> 1 then raise exception 'FAIL rollback: payment delete was not rolled back'; end if;
  select count(*) into cnt from public.mortgage_rate_periods where id = 'rate-a-rollback';
  if cnt <> 1 then raise exception 'FAIL rollback: rate period was deleted'; end if;

  drop trigger plan94_force_failure on public.mortgage_rate_periods;

  -- Happy path removes the parent and both linked history types together while
  -- retaining unrelated rows and the property-wide (null loan_part_id) period.
  perform public.delete_mortgage_loan_part('part-a');
  select count(*) into cnt from public.mortgage_loan_parts where id = 'part-a';
  if cnt <> 0 then raise exception 'FAIL success: parent remains'; end if;
  select count(*) into cnt from public.mortgage_payments where id = 'pay-a';
  if cnt <> 0 then raise exception 'FAIL success: payment remains'; end if;
  select count(*) into cnt from public.mortgage_rate_periods where id = 'rate-a';
  if cnt <> 0 then raise exception 'FAIL success: rate period remains'; end if;
  select count(*) into cnt from public.mortgage_loan_parts where id = 'part-a-keep';
  if cnt <> 1 then raise exception 'FAIL success: unrelated parent changed'; end if;
  select count(*) into cnt from public.mortgage_rate_periods where id = 'rate-a-property';
  if cnt <> 1 then raise exception 'FAIL success: property-wide rate period changed'; end if;

  raise notice 'ALL PASS — mortgage loan-part deletion is atomic and household-scoped';
end;
$$;

rollback;
