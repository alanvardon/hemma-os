-- Plan 139 Stage 1 — in-app salary halves (the Löner tool).
--
-- Each person now submits only their OWN half of a month's salaries in the app,
-- the same way the plan-132 email link already works. The app writes the same
-- public.salary_submission_drafts rows (submitted_via = 'app', the value plan
-- 132 reserved) and completion still goes through private.finalize_salary_month,
-- so the month row keeps exactly the buildSubmission shape (D1).
--
-- Ownership: no new tables. Drafts stay HOUSEHOLD-owned; the household always
-- comes from the session (private.current_household()), never from an argument.
--
-- Write path: public.save_salary_half is the ONLY in-app write path for halves.
-- Clients still have SELECT only on salary_submission_drafts (plan 132); this
-- security-definer function does the write after its own checks:
--   • create a half → only the caller's own slot (household_people.assigned_email
--     = the caller's login email), or a slot with no assigned email (D2/D3);
--   • edit an existing half → any household member (D2), but only against the
--     updated_at they last saw (optimistic concurrency, 40001 on mismatch);
--   • a month that already has a salary_submissions row → 'already_logged', no
--     write (the client then edits that row through the outbox instead).
--
-- Duplicate months (D6): the save takes the month's advisory lock — the same
-- pg_advisory_xact_lock(hashtext(household || month)) finalize_salary_month
-- takes — and checks for an existing row under it. So the plan-132 "Accepted
-- trade-off" race (an in-app save and an email finalize both writing a row for
-- the same month) is gone for the app: the in-app path no longer inserts
-- month rows through the outbox at all. Existing production duplicates are
-- untouched, and no unique (household_id, month) constraint is added (it would
-- fail on them). JSON import may still add a duplicate month; out of scope.
--
-- Edge Function (unchanged): the salary-reminder function still upserts the
-- half directly, WITHOUT an updated_at check. If the slot's own person
-- re-submits from their email link after their partner edited that half in the
-- app, the email submission overwrites the edit. That is accepted
-- last-write-wins from the half's own person.
--
-- No cron, HTTP or extension wiring here: safe on `supabase db reset` and in CI.

-- ── validated half items ──────────────────────────────────────────────────────
-- Mirrors validateHalf in supabase/functions/_shared/salary-reminder-logic.ts
-- exactly — reject, never clamp or coerce:
--   • an array of AT MOST 20 entries, counted on the RAW array (before dropping
--     empties);
--   • each entry an object with a string `label` (≤ 80 characters after trim)
--     and a jsonb number `amount` with |amount| ≤ 10 000 000 (negatives
--     allowed; strings rejected);
--   • then labels are trimmed and items with an empty label AND a zero amount
--     are dropped. Order is preserved; amounts stay exact numeric.
-- Returns [{label, amount}]; raises 22023 'invalid salary items' otherwise.
-- Trim uses the same whitespace set as private.salary_owned_items.

create or replace function private.salary_validated_items(p_items jsonb)
    returns jsonb
    language plpgsql
    immutable
    set search_path to ''
    as $$
declare
  result jsonb;
begin
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) > 20 then
    raise exception using errcode = '22023', message = 'invalid salary items';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) e(item)
    where pg_catalog.jsonb_typeof(e.item) <> 'object'
       or pg_catalog.jsonb_typeof(e.item -> 'label') is distinct from 'string'
       or pg_catalog.jsonb_typeof(e.item -> 'amount') is distinct from 'number'
       or pg_catalog.length(pg_catalog.btrim(e.item ->> 'label', E' \t\n\r\f\v')) > 80
       or abs((e.item ->> 'amount')::numeric) > 10000000
  ) then
    raise exception using errcode = '22023', message = 'invalid salary items';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('label', n.label, 'amount', n.amount)
             order by n.ord),
           '[]'::jsonb)
    into result
  from (
    select e.ord,
           pg_catalog.btrim(e.item ->> 'label', E' \t\n\r\f\v') as label,
           (e.item ->> 'amount')::numeric as amount
    from pg_catalog.jsonb_array_elements(p_items) with ordinality e(item, ord)
  ) n
  where n.label <> '' or n.amount <> 0;

  return result;
end;
$$;

alter function private.salary_validated_items(jsonb) owner to postgres;
revoke all on function private.salary_validated_items(jsonb) from public, anon, authenticated;

-- ── may the caller CREATE this slot's half? ───────────────────────────────────
-- True when the slot's household_people.assigned_email is the caller's login
-- email (D2), or when the slot has no assigned email — including no
-- household_people row at all (D3: otherwise a household with one bound person
-- could never complete a month). An assigned slot stays strictly own-only even
-- if that person has not signed up yet; they use their email link.
--
-- The caller's email is resolved EXACTLY as public.household_identity() does
-- (20260719100000_household_person_identity.sql): lower(auth.users.email) for
-- auth.uid(), compared with = against the stored lowercase/trimmed
-- assigned_email. Never from the JWT or an argument.

create or replace function private.caller_may_create_salary_half(p_household uuid, p_slot text)
    returns boolean
    language plpgsql
    security definer
    set search_path to ''
    stable
    as $$
declare
  uid uuid := (select auth.uid());
  my_email text;
  slot_email text;
begin
  if uid is null or p_household is null or p_slot is null or p_slot not in ('a', 'b') then
    return false;
  end if;
  select lower(email) into my_email from auth.users where id = uid;
  select hp.assigned_email into slot_email from public.household_people hp
   where hp.household_id = p_household and hp.slot = p_slot;
  if slot_email is null then
    return true;
  end if;
  return my_email is not null and slot_email = my_email;
end;
$$;

alter function private.caller_may_create_salary_half(uuid, text) owner to postgres;
revoke all on function private.caller_may_create_salary_half(uuid, text) from public, anon, authenticated;

-- ── the in-app write path for one half ────────────────────────────────────────
--
-- p_expected_updated_at: null when CREATING a half; the draft's updated_at as
-- last read when EDITING one. A mismatch either way is 40001 'salary half
-- conflict' — nothing is silently overwritten, and a half that vanished (the
-- month finalised or was discarded) while someone edited it is a conflict too,
-- unless the month is now logged (then 'already_logged' wins, checked first).
--
-- Returns {"status": s, "updated_at": t}:
--   'already_logged' — the month has a salary_submissions row; nothing written
--                      (updated_at absent).
--   'pending'        — the half is saved and waits for the other one.
--   'zero_total'     — both halves exist but sum to <= 0; both are kept.
--   'finalized'      — this save completed the month (updated_at null: the
--                      drafts were cleared into the new row).
-- Errors: 42501 not in a household / 'not your salary'; 22023 invalid month,
-- slot, items or note (> 200 characters after trim); 40001 conflict.
--
-- Upsert on the drafts key, never delete-then-insert (plan 43). The
-- set_updated_at trigger bumps updated_at on the edit path; the advisory lock
-- is re-entrant, so finalize_salary_month takes it again harmlessly.

create or replace function public.save_salary_half(
  p_month text, p_slot text, p_items jsonb, p_note text, p_expected_updated_at timestamptz)
    returns jsonb
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  hid uuid := (select private.current_household());
  uid uuid := (select auth.uid());
  note_in text;
  items jsonb;
  existing public.salary_submission_drafts%rowtype;
  outcome text;
begin
  if uid is null or hid is null then
    raise exception using errcode = '42501', message = 'not in a household';
  end if;
  if p_slot is null or p_slot not in ('a', 'b') then
    raise exception using errcode = '22023', message = 'invalid salary slot';
  end if;
  if not private.is_salary_month(p_month) then
    raise exception using errcode = '22023', message = 'invalid salary month';
  end if;
  note_in := nullif(pg_catalog.btrim(p_note, E' \t\n\r\f\v'), '');
  if pg_catalog.length(note_in) > 200 then
    raise exception using errcode = '22023', message = 'invalid salary note';
  end if;
  items := private.salary_validated_items(p_items);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(hid::text || p_month));

  if exists (select 1 from public.salary_submissions
              where household_id = hid and month = p_month) then
    return pg_catalog.jsonb_build_object('status', 'already_logged');
  end if;

  select * into existing from public.salary_submission_drafts
   where household_id = hid and month = p_month and slot = p_slot
   for update;

  if found then
    -- Edit: any member (D2), but only against the version they saw.
    if p_expected_updated_at is distinct from existing.updated_at then
      raise exception using errcode = '40001', message = 'salary half conflict';
    end if;
  else
    -- Create: own slot only (D2), or an unassigned slot (D3).
    if p_expected_updated_at is not null then
      raise exception using errcode = '40001', message = 'salary half conflict';
    end if;
    if not private.caller_may_create_salary_half(hid, p_slot) then
      raise exception using errcode = '42501', message = 'not your salary';
    end if;
  end if;

  insert into public.salary_submission_drafts
    (household_id, month, slot, income_items, note, submitted_via)
  values (hid, p_month, p_slot, items, note_in, 'app')
  on conflict (household_id, month, slot) do update
    set income_items = excluded.income_items,
        note = excluded.note,
        submitted_via = 'app';

  outcome := private.finalize_salary_month(hid, p_month);

  return pg_catalog.jsonb_build_object(
    'status', outcome,
    'updated_at', (select d.updated_at from public.salary_submission_drafts d
                    where d.household_id = hid and d.month = p_month and d.slot = p_slot));
end;
$$;

alter function public.save_salary_half(text, text, jsonb, text, timestamptz) owner to postgres;
revoke all on function public.save_salary_half(text, text, jsonb, text, timestamptz) from public, anon;
grant execute on function public.save_salary_half(text, text, jsonb, text, timestamptz) to authenticated;
