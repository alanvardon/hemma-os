# Plan 48 — Månadsavslut: atomic settle/unsettle via RPC

**Status:** plan · **Severity: MEDIUM (M2)** · **Source:** repo audit 2026-07-06 ·
**Req:** 6 of the audit batch ·
Touches a new `supabase/migrations/` file + `web/src/lib/manadsavslut-store.ts`.

## Finding

`settle()` (manadsavslut-store.ts:270–285) inserts the payment row, then flips
the settled items to `paid` in a SECOND request; `removePayment` (289–300) is
the mirror (un-flip items, then delete the payment). The ordering is
deliberately chosen so a partial failure is retryable rather than corrupting —
good — but a crash/network drop between the two statements still leaves a
settlement whose items are unsettled (or vice versa on remove), and nothing
ever reconciles it.

## Fix

One `security definer` RPC per direction, each a single transaction:

```sql
create or replace function public.settle_items(
  p_id text, p_item_ids jsonb, p_from text, p_to text,
  p_amount numeric, p_period_label text, p_note text, p_created_at timestamptz
) returns void language plpgsql security definer set search_path to '' as $$
declare hid uuid := (select private.current_household());
begin
  if hid is null then raise exception 'no household'; end if;
  insert into public.monthend_payments (id, household_id, created_at, item_ids,
    from_person, to_person, amount, period_label, note)
  values (p_id, hid, coalesce(p_created_at, now()), p_item_ids,
    p_from, p_to, p_amount, coalesce(p_period_label, ''), coalesce(p_note, ''));
  update public.monthend_items set paid = true, payment_id = p_id
    where household_id = hid
      and id in (select jsonb_array_elements_text(p_item_ids));
end; $$;

create or replace function public.unsettle_payment(p_id text)
returns void language plpgsql security definer set search_path to '' as $$
declare hid uuid := (select private.current_household());
begin
  if hid is null then raise exception 'no household'; end if;
  update public.monthend_items set paid = false, payment_id = null
    where household_id = hid and payment_id = p_id;
  delete from public.monthend_payments where household_id = hid and id = p_id;
end; $$;

grant execute on function public.settle_items(text, jsonb, text, text, numeric, text, text, timestamptz) to authenticated;
grant execute on function public.unsettle_payment(text) to authenticated;
```

Security-definer bypasses RLS, so BOTH functions must pin every statement to
`hid` explicitly (as above) — that replicates the `hh_all` policy inside the
transaction.

**manadsavslut-store.ts:** `settle()` and `removePayment()` become single
`supabase.rpc(...)` calls; keep the same signatures, throws and cache patching
(cache patch after success, per plan 47).

## Acceptance criteria

- Settle and reopen work end-to-end in the UI (Playwright auth session).
- RPC rejects when called for another household's item/payment ids (pin
  check): craft an id not in your household → 0 rows affected, no leak.
- Store unit tests updated to mock `rpc` instead of the two-step calls.
