# Plan 16a — Supabase foundation + auth gate (Phase A, PR 1)

**Parent:** [Plan 16](16-supabase-migration-auth.md) (master — read its *Supabase
in five minutes*, *Decisions*, *RLS* and *Risks* sections first). · **Branch:**
`ui/supabase-auth-gate` · **Prereqinites:** none — this is the first step.

## Goal

Stand up the Supabase project, the household/membership tables + RLS, and a
login gate over the whole app — **without migrating any tool data yet**. When
this PR merges, the app behaves exactly as before (still localStorage) but
requires a magic-link sign-in, and your seeded household exists in the cloud
ready for 16b. This is the foundation every later phase builds on.

## Part 1 — dashboard setup (no code; all in the browser)

1. **Create the project.** [supabase.com](https://supabase.com) → sign up
   (GitHub login is easiest) → *New project*, name `hemma-os`, region
   **Stockholm (eu-north-1)**, free plan. It asks for a *database password* —
   that's for direct Postgres access, not the app; generate one, store it in
   your password manager. Wait ~2 min for provisioning.
2. **Copy the two values the app needs**, both under *Project Settings*: the
   **Project URL** (`https://<ref>.supabase.co`, under *Data API*) and the
   **publishable key** (`sb_publishable_…`, under *API Keys*). Never touch the
   secret key.
3. **Configure auth URLs** (*Authentication → URL Configuration*): set **Site
   URL** to `https://alanvardon.github.io/hemma-os/` and add
   `http://localhost:5173/**` to the **Redirect URLs** allow-list. Magic links
   only redirect to URLs on this list — get it wrong and links silently fail.
   Email sign-in is on by default; nothing else to toggle.

## Part 2 — the schema (SQL Editor → New query; run top to bottom)

Household + membership tables (these are OURS, so real `uuid` keys):

```sql
create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id),
  user_id      uuid not null references auth.users(id),
  role         text not null default 'member',
  primary key (household_id, user_id)
);

create table public.household_invites (   -- used in 16h; created now
  household_id uuid not null references public.households(id),
  email        text not null,
  created_at   timestamptz not null default now(),
  primary key (household_id, email)
);
```

The `current_household()` helper — **`security definer` + the `grant` are both
mandatory** (see master *Household* section for why: recursion + schema
permission):

```sql
create schema if not exists private;

create or replace function private.current_household()
returns uuid
language sql
security definer
set search_path = ''
as $$
  select household_id from public.household_members
  where user_id = (select auth.uid())
  limit 1;
$$;

grant usage on schema private to authenticated;
```

Household RLS (read-only from the client; the seed runs as owner and bypasses
RLS):

```sql
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

create policy hh_read on public.households for select to authenticated
  using (id = (select private.current_household()));
create policy hm_read on public.household_members for select to authenticated
  using (household_id = (select private.current_household()));
```

Enable the `moddatetime` extension now (every later data table's `updated_at`
trigger needs it):

```sql
create extension if not exists moddatetime schema extensions;
```

(Historically these ran in the SQL Editor and were kept in `supabase/schema.sql`.
After 16c the project adopted Supabase CLI migrations: `supabase db pull`
captured this schema into the baseline migration `supabase/migrations/…_remote_schema.sql`,
and `schema.sql` was retired. New schema changes are migrations — see the master
plan's Risks note.)

## Part 3 — the code

1. **Gitignore fix FIRST.** The root `.gitignore` lists only `.env`, which does
   **not** match `.env.local`. Add `.env*` before creating any env file.
2. `npm install @supabase/supabase-js` in `web/`.
3. `web/src/lib/supabase.ts`:
   ```ts
   import { createClient } from '@supabase/supabase-js'
   export const supabase = createClient(
     import.meta.env.VITE_SUPABASE_URL,
     import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
   )
   ```
4. `web/.env.local` (now gitignored): `VITE_SUPABASE_URL=…` +
   `VITE_SUPABASE_PUBLISHABLE_KEY=…`.
5. **`<AuthGate>` in `App.tsx`**, wrapping `<RouterProvider>` **inside** the
   existing `ThemeContext.Provider` (so the login screen is themed). Loading →
   splash/null; no session → magic-link screen (email input + "Skicka länk" +
   "check your inbox" state); session → the router. Standard pattern:
   ```ts
   supabase.auth.getSession().then(({ data }) => setSession(data.session))
   const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
   // send:
   await supabase.auth.signInWithOtp({
     email,
     options: { emailRedirectTo: window.location.origin + window.location.pathname },
   })
   ```
   Remember to `sub.subscription.unsubscribe()` on unmount.
6. **Catch-all route.** The `createHashRouter` config currently has NO `*`
   route, so a magic-link callback hash (`#access_token…`) lands on React
   Router's error page. Add `{ path: '*', element: <Navigate to="/" replace /> }`
   as the last child of the layout route. `emailRedirectTo` above already
   targets the bare root.
7. **Deploy secrets.** Repo *Settings → Secrets and variables → Actions* → add
   `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. In `deploy.yml`'s "Build the
   React app" step add:
   ```yaml
           env:
             VITE_SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
             VITE_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.SUPABASE_PUBLISHABLE_KEY }}
   ```

## Part 4 — sign in + seed the household

8. **Both of you sign in once** (localhost is fine). This creates your rows in
   `auth.users`, which the seed needs. Tools appear empty — you have no
   household yet.
9. **Seed** (SQL Editor, runs as owner → bypasses RLS):
   ```sql
   insert into public.households (name) values ('Vardon') returning id;   -- copy id
   insert into public.household_members (household_id, user_id, role)
   select '<paste-id>', id, 'owner'
   from auth.users
   where email in ('alan.vardon@proton.me', '<partner-email>');
   select * from public.household_members;   -- expect 2 rows
   ```

## Verification gate / Definition of done

- `npm run build` + `npx oxlint` + `npx vitest run` green in `web/`.
- Magic-link round trip works on **localhost AND the live Pages site** (this is
  the environment-dependent hash-router check — do both).
- After seeding, both accounts land in the app; an unknown hash (e.g.
  `#/does-not-exist`) redirects to the hub, not an error page.
- The app still works otherwise unchanged (all tools still localStorage).

**Next:** [16b](16b-supabase-salary-pilot.md) — the salary-store pilot.
