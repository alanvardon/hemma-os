-- Plan 95. Lifecycle calls take a transaction-scoped advisory lock derived
-- from auth.uid(), then stable household-row locks. Household FOR UPDATE locks
-- conflict with FK checks from concurrent household-owned inserts, making the
-- persisted-data scan stable until commit.
--
-- private.household_has_persisted_data discovers every current/future public
-- table with the standard household_id ownership column; household_members is
-- excluded because that is the membership being moved. Tests assert every such
-- table has a FK to households. Multiple active inviting household ids raise
-- P0003 and consume nothing. A sole member moving from a household with any
-- persisted household-owned row raises P0004 and preserves everything; a
-- data-free old household is deleted after the move.

create or replace function private.household_has_persisted_data(p_hid uuid)
returns boolean language plpgsql security definer set search_path to '' as $$
declare owned_table record; has_rows boolean;
begin
  for owned_table in
    select n.nspname schema_name, c.relname table_name
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid=a.attrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
      and a.attname='household_id' and a.attnum>0 and not a.attisdropped
      and c.relname<>'household_members'
    order by n.nspname,c.relname
  loop
    execute pg_catalog.format('select exists (select 1 from %I.%I where household_id=$1)',owned_table.schema_name,owned_table.table_name)
      into has_rows using p_hid;
    if has_rows then return true; end if;
  end loop;
  return false;
end; $$;
alter function private.household_has_persisted_data(uuid) owner to postgres;
revoke all on function private.household_has_persisted_data(uuid) from public,anon,authenticated;

create or replace function public.claim_household() returns uuid
language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := (select auth.uid());
  mail text := pg_catalog.lower((select auth.jwt()->>'email'));
  hid uuid; target_hid uuid; new_hid uuid; targets uuid[]; consumed integer;
begin
  if uid is null then return null; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,9500));
  select household_id into hid from public.household_members where user_id=uid;
  if hid is not null then return hid; end if;
  if mail is not null then
    loop
      perform 1 from public.household_invites
        where email=mail and created_at>pg_catalog.now()-interval '30 days'
        order by household_id for update;
      select pg_catalog.array_agg(q.household_id order by q.household_id) into targets
      from (select distinct household_id from public.household_invites
        where email=mail and created_at>pg_catalog.now()-interval '30 days') q;
      if coalesce(pg_catalog.cardinality(targets),0)>1 then
        raise sqlstate 'P0003' using message='ambiguous household invitations';
      end if;
      target_hid:=targets[1];
      exit when target_hid is null;
      perform 1 from public.households where id=target_hid for update;
      perform 1 from public.household_invites
        where email=mail and created_at>pg_catalog.now()-interval '30 days'
        order by household_id for update;
      select pg_catalog.array_agg(q.household_id order by q.household_id) into targets
      from (select distinct household_id from public.household_invites
        where email=mail and created_at>pg_catalog.now()-interval '30 days') q;
      if coalesce(pg_catalog.cardinality(targets),0)>1 then
        raise sqlstate 'P0003' using message='ambiguous household invitations';
      end if;
      exit when targets[1] is not distinct from target_hid;
    end loop;
  end if;
  if target_hid is not null then
    delete from public.household_invites where household_id=target_hid and email=mail
      and created_at>pg_catalog.now()-interval '30 days';
    get diagnostics consumed=row_count;
    if consumed<>1 then raise exception 'no invite'; end if;
    insert into public.household_members(household_id,user_id,role) values(target_hid,uid,'member');
    return target_hid;
  end if;
  insert into public.households(name) values('Mitt hushåll') returning id into new_hid;
  insert into public.household_members(household_id,user_id,role) values(new_hid,uid,'owner') on conflict(user_id) do nothing;
  select household_id into strict hid from public.household_members where user_id=uid;
  if new_hid is distinct from hid then delete from public.households where id=new_hid; end if;
  return hid;
end; $$;
alter function public.claim_household() owner to postgres;
revoke all on function public.claim_household() from public,anon;
grant execute on function public.claim_household() to authenticated;

create or replace function public.accept_invite() returns uuid
language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := (select auth.uid());
  mail text := pg_catalog.lower((select auth.jwt()->>'email'));
  current_hid uuid; target_hid uuid; targets uuid[]; member_count integer; consumed integer;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if mail is null then raise exception 'no invite'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,9500));
  select household_id into current_hid from public.household_members where user_id=uid;
  loop
    perform 1 from public.household_invites
      where email=mail and created_at>pg_catalog.now()-interval '30 days'
      order by household_id for update;
    select pg_catalog.array_agg(q.household_id order by q.household_id) into targets
    from (select distinct household_id from public.household_invites
      where email=mail and created_at>pg_catalog.now()-interval '30 days') q;
    if coalesce(pg_catalog.cardinality(targets),0)>1 then
      raise sqlstate 'P0003' using message='ambiguous household invitations';
    end if;
    target_hid:=targets[1];
    if target_hid is null then raise exception 'no invite'; end if;
    perform 1 from public.households where id=current_hid or id=target_hid order by id for update;
    perform 1 from public.household_invites
      where email=mail and created_at>pg_catalog.now()-interval '30 days'
      order by household_id for update;
    select pg_catalog.array_agg(q.household_id order by q.household_id) into targets
    from (select distinct household_id from public.household_invites
      where email=mail and created_at>pg_catalog.now()-interval '30 days') q;
    if coalesce(pg_catalog.cardinality(targets),0)>1 then
      raise sqlstate 'P0003' using message='ambiguous household invitations';
    end if;
    exit when targets[1] is not distinct from target_hid;
  end loop;
  select household_id into current_hid from public.household_members where user_id=uid;
  if current_hid is not null and current_hid is distinct from target_hid then
    select pg_catalog.count(*) into member_count from public.household_members where household_id=current_hid;
    if member_count=1 and private.household_has_persisted_data(current_hid) then
      raise sqlstate 'P0004' using message='household contains persisted data';
    end if;
  end if;
  delete from public.household_invites where household_id=target_hid and email=mail
    and created_at>pg_catalog.now()-interval '30 days';
  get diagnostics consumed=row_count;
  if consumed<>1 then raise exception 'no invite'; end if;
  if current_hid is not distinct from target_hid then return target_hid; end if;
  if current_hid is not null then
    delete from public.household_members where household_id=current_hid and user_id=uid;
  end if;
  insert into public.household_members(household_id,user_id,role) values(target_hid,uid,'member');
  if current_hid is not null and member_count=1 then delete from public.households where id=current_hid; end if;
  return target_hid;
end; $$;
alter function public.accept_invite() owner to postgres;
revoke all on function public.accept_invite() from public,anon;
grant execute on function public.accept_invite() to authenticated;

create or replace function public.leave_household() returns void
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); hid uuid; member_count integer;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,9500));
  select household_id into hid from public.household_members where user_id=uid;
  if hid is null then raise exception 'not in a household'; end if;
  perform 1 from public.households where id=hid for update;
  select household_id into hid from public.household_members where user_id=uid;
  if hid is null then raise exception 'not in a household'; end if;
  select pg_catalog.count(*) into member_count from public.household_members where household_id=hid;
  if member_count<=1 then raise exception 'last member cannot leave'; end if;
  delete from public.household_members where household_id=hid and user_id=uid;
end; $$;
alter function public.leave_household() owner to postgres;
revoke all on function public.leave_household() from public,anon;
grant execute on function public.leave_household() to authenticated;
