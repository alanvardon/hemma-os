-- Plan 107: retain legacy mortgage_contributions as canonical down-payment
-- rows in mortgage_payments. The old rows stay in place for rollback/audit.
--
-- The reserved id/source prefix is also used by the cache and backup converter.
-- ON CONFLICT makes this data migration repeatable, while the legacy id suffix
-- keeps each household contribution stable across every migration path.
create or replace function private.plan107_valid_iso_date(value text)
returns boolean
language plpgsql
immutable
set search_path to ''
as $$
begin
  return value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and pg_catalog.to_char(value::date, 'YYYY-MM-DD') = value;
exception when others then
  return false;
end;
$$;
revoke all on function private.plan107_valid_iso_date(text) from public, anon, authenticated;

insert into public.mortgage_payments (
  id,
  household_id,
  created_at,
  loan_part_id,
  date,
  kind,
  description,
  amount,
  balance_after,
  paid_by,
  source,
  is_insats,
  paid_split
)
select
  'legacy-contribution:' || contribution.id,
  contribution.household_id,
  contribution.created_at,
  null,
  contribution.date,
  'down_payment',
  contribution.note,
  contribution.amount,
  null,
  contribution.owner,
  'legacy-contribution:' || contribution.id,
  true,
  null
from public.mortgage_contributions as contribution
where contribution.id <> ''
  and contribution.amount > 0
  and contribution.amount::text <> 'NaN'
  and contribution.owner in ('a', 'b', 'joint')
  and private.plan107_valid_iso_date(contribution.date)
on conflict (id) do nothing;

drop function private.plan107_valid_iso_date(text);
