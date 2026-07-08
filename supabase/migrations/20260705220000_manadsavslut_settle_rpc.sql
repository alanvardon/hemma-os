-- Plan 48 (M2) — Månadsavslut: atomic settle / unsettle via security-definer RPC.
--
-- Before this, settle() was two client round-trips (insert the payment, THEN
-- flip the settled items to paid) and removePayment() the mirror. A crash or
-- network drop between the two statements left a half-finished settlement that
-- nothing ever reconciled. These functions fold each direction into ONE
-- transaction, so the two writes now commit or roll back together.
--
-- SECURITY DEFINER bypasses RLS, so every statement re-pins the row to the
-- caller's household by hand — that replicates the `hh_all` policy inside the
-- transaction. A payload carrying another household's item/payment ids matches
-- zero rows (the `household_id = hid` predicate), so it can neither read nor
-- write across tenants. search_path is '' so all names are schema-qualified.

-- ── settle_items: insert the payment + flip its items to paid, atomically ─────
create or replace function "public"."settle_items"(
  "p_id" "text", "p_item_ids" "jsonb", "p_from" "text", "p_to" "text",
  "p_amount" numeric, "p_period_label" "text", "p_note" "text", "p_created_at" timestamp with time zone
) returns void
    language "plpgsql"
    security definer
    set "search_path" to ''
    as $$
declare
  hid uuid := (select "private"."current_household"());
begin
  if hid is null then
    raise exception 'no household';
  end if;

  insert into public.monthend_payments
    (id, household_id, created_at, item_ids, from_person, to_person, amount, period_label, note)
  values
    (p_id, hid, coalesce(p_created_at, now()), coalesce(p_item_ids, '[]'::jsonb),
     p_from, p_to, coalesce(p_amount, 0), coalesce(p_period_label, ''), coalesce(p_note, ''));

  update public.monthend_items
    set paid = true, payment_id = p_id
    where household_id = hid
      and id in (select jsonb_array_elements_text(coalesce(p_item_ids, '[]'::jsonb)));
end;
$$;

alter function "public"."settle_items"("text", "jsonb", "text", "text", numeric, "text", "text", timestamp with time zone) owner to "postgres";
grant execute on function "public"."settle_items"("text", "jsonb", "text", "text", numeric, "text", "text", timestamp with time zone) to "authenticated";

-- ── unsettle_payment: un-flip the items + delete the payment, atomically ──────
create or replace function "public"."unsettle_payment"("p_id" "text")
    returns void
    language "plpgsql"
    security definer
    set "search_path" to ''
    as $$
declare
  hid uuid := (select "private"."current_household"());
begin
  if hid is null then
    raise exception 'no household';
  end if;

  update public.monthend_items
    set paid = false, payment_id = null
    where household_id = hid and payment_id = p_id;

  delete from public.monthend_payments where household_id = hid and id = p_id;
end;
$$;

alter function "public"."unsettle_payment"("text") owner to "postgres";
grant execute on function "public"."unsettle_payment"("text") to "authenticated";
