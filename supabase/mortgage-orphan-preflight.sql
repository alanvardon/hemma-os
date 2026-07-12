-- Read-only preflight for any future loan_part_id foreign-key migration.
--
-- Run against the intended database before proposing a constraint. A non-zero
-- count means the dependent row has no parent in the same household, including
-- a corrupt cross-household association. Plan 94 deliberately adds no FK and
-- does not repair or delete legacy data.

select 'mortgage_payments' as relation, count(*) as orphan_count
from public.mortgage_payments as dependent
left join public.mortgage_loan_parts as parent
  on parent.household_id = dependent.household_id
 and parent.id = dependent.loan_part_id
where dependent.loan_part_id is not null
  and parent.id is null
union all
select 'mortgage_rate_periods' as relation, count(*) as orphan_count
from public.mortgage_rate_periods as dependent
left join public.mortgage_loan_parts as parent
  on parent.household_id = dependent.household_id
 and parent.id = dependent.loan_part_id
where dependent.loan_part_id is not null
  and parent.id is null
order by relation;
