-- Local-only seed (runs at the end of `supabase db reset`; never applied to a
-- remote/prod project). Its job: pre-create the throwaway dev user that
-- web/src/lib/devAuth.ts signs in with — PLUS its household + owner membership —
-- so the isolated dev server auto-logs-in into a fully usable, cloud-backed state.
--
-- Two things this sidesteps:
--   1. Plan 46's invite-only Before-User-Created hook
--      (public.hook_before_user_created): it 403s any signup whose email has no
--      invite. Pre-creating the user means devAuth's first signInWithPassword
--      succeeds directly — the hook only fires on *creation*, so it never runs.
--   2. claim_household()'s racy first-time-claim path: AuthGate calls
--      claim_household on every sign-in, and React StrictMode double-invokes it in
--      dev. Two concurrent first-time claims collide on the household_members
--      user_id unique index and can BOTH roll back, leaving the user with no
--      household (verified). By seeding the membership here, claim_household hits
--      its "already a member" short-circuit (a pure read, no writes) and the race
--      never happens.
--
-- The password is hashed in-SQL via pgcrypto's crypt()/bcrypt, so no hash is
-- hardcoded and it always matches devAuth's VITE_DEV_PASSWORD default.
--
-- Keep the email/password in sync with devAuth.ts (dev@local.test /
-- local-dev-password). Idempotent: on conflict do nothing, so re-running is safe.
--
-- Fragility note: this hand-writes an auth.users row. If a future Supabase bump
-- makes a new auth.users column NOT NULL without a default, this seed will fail
-- loudly at `db reset` time (local only — it can never reach prod) and needs the
-- new column added here. The columns below are what GoTrue needs functionally for
-- a confirmed password login (see the token-column note on the insert).

-- The token columns are set to '' (not left NULL): GoTrue's password-grant login
-- scans confirmation_token / recovery_token / email_change / email_change_token_new
-- into non-nullable Go strings and 500s if they are NULL. (The admin API sets
-- them to ''; a raw insert must do the same.)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000d0001',
  'authenticated', 'authenticated', 'dev@local.test',
  crypt('local-dev-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"email_verified":true}',
  '', '', '', '',
  now(), now()
) on conflict (id) do nothing;

-- GoTrue expects a matching email identity for the account.
insert into auth.identities (
  provider_id, user_id, identity_data, provider, created_at, updated_at
) values (
  '00000000-0000-0000-0000-0000000d0001',
  '00000000-0000-0000-0000-0000000d0001',
  '{"sub":"00000000-0000-0000-0000-0000000d0001","email":"dev@local.test","email_verified":true}',
  'email', now(), now()
) on conflict do nothing;

-- The dev user's own household + owner membership. Seeding the membership makes
-- claim_household() short-circuit on "already a member" (see header note 2), so
-- cloud-backed tools (Bolånekoll, Hushållsbudget, …) have a household from the
-- first load with no dependency on the racy claim path.
insert into public.households (id, name)
  values ('00000000-0000-0000-0000-0000000d00d0', 'Dev household')
  on conflict (id) do nothing;
insert into public.household_members (household_id, user_id, role)
  values (
    '00000000-0000-0000-0000-0000000d00d0',
    '00000000-0000-0000-0000-0000000d0001',
    'owner'
  ) on conflict do nothing;
