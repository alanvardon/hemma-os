# Hemma OS development guide

## Product and priorities

Hemma OS is a production application for managing the household and, over time, broader parts of everyday life. Its current focus is household finance. It is built for the repository owner and their partner rather than as a generic SaaS product.

Swedish language, financial rules, dates, number formats, housing practices, and household context are domain requirements, not incidental localisation.

Prioritise, in order:

1. Financial correctness.
2. Ease of use, especially on mobile.
3. Contemporary visual quality and polished interaction.

The product should feel cutting-edge, sharp, cohesive, and exceptionally well made. Do not trade away security, financial meaning, maintainability, or data safety to achieve visual novelty.

## Authority and uncertainty

- The user's latest explicit instruction has highest authority.
- Treat current application behaviour as intentional and authoritative unless the task changes it.
- Tests and current code are evidence of shipped behaviour. If they disagree, investigate rather than choosing whichever is convenient.
- Active planning documents describe product intent and are starting points, not immutable specifications.
- `planning/completed/` is historical context only. Do not audit completed plans during ordinary implementation, and do not assume they describe exactly what shipped.
- Suggest improvements freely, but do not implement unrequested product ideas.
- Stop and ask before deciding unclear financial meaning.
- Ask before material architectural changes, scope expansion, new dependencies, browser-support trade-offs, material UX deviations, security-boundary changes, or changes to persisted-data semantics.
- If one decision is blocked, continue safe independent work and return to the blocked part after receiving guidance.
- Report every meaningful deviation from the requested or planned approach in the completion summary.

## Repository scope

The primary product is the React/TypeScript/Vite application in `web/`.

- `web/src/routes/`: page-level composition and route-owned UI.
- `web/src/routes/<tool>/`: components and dialogs specific to one tool.
- `web/src/components/`: genuinely shared UI primitives and components.
- `web/src/components/charts/`: shared chart rendering, data preparation, legends, sizing, and themes.
- `web/src/lib/`: pure domain logic, financial calculations, formatting, persistence adapters, migrations, and reusable utilities.
- `web/src/store/`: Zustand coordination for Bostadskalkyl scenarios.
- `web/src/styles/`: shared tokens, global styles, and tool-specific CSS.
- `supabase/`: schema migrations, RLS and database tests, seed data, configuration, and edge functions.
- `planning/`: proposed work and decision context.

`orchestrator/` is a separate, temporary project and is outside these development instructions. Do not modify it as part of Hemma OS work unless the user explicitly requests that project.

The root `calc.js` and `calc.test.js` are legacy predecessors of `web/src/lib/calc.ts` and its Vitest coverage. They remain coupled to the temporary orchestrator configuration. Do not treat them as authoritative application code or update/remove them opportunistically.

## Architecture

Preserve this direction of responsibility:

```text
React routes and components
        -> state coordination
        -> pure domain logic and persistence adapters
        -> Supabase and local browser storage
```

- Keep financial and domain calculations pure, typed, deterministic, and independent of React, Zustand, Supabase, and browser APIs.
- Put new or materially changed financial rules in `web/src/lib/` and cover them with automated tests.
- Components may perform trivial presentation transformations. Do not hide business rules inside JSX, effects, or event handlers.
- Route ordinary database access through stores or persistence adapters. Keep authentication behind its existing boundary rather than scattering Supabase calls through components.
- Decompose code according to cohesion. File length is a warning signal, not a rule. Extract concepts that have clear ownership; do not fragment code merely to reduce line counts.
- Keep feature-specific components beside their route. Promote them to shared components only when they represent a stable shared primitive or have multiple genuine consumers.
- Prefer clarity over aggressive DRY. Abstract only when concepts and their change patterns are genuinely shared. Similar-looking financial values may have different meanings, bases, periods, or ownership.
- Reuse or extend existing buttons, dialogs, fields, cards, charts, toasts, tokens, and other shared UI before creating variants.
- Preserve the existing CSS and token architecture. Do not introduce Tailwind, CSS-in-JS, a component library, or a new styling system without approval.
- When existing architecture needs substantial correction, propose a separate refactor. Do not combine it with feature work without approval.
- Do not perform opportunistic cleanup. Make only changes required by the task; report separate improvement opportunities instead.

## Financial correctness

- Never guess at unclear financial semantics. Ask with a concrete interpretation and example calculation.
- Verify changed Swedish tax, mortgage, amortisation, housing, or legal rules against current authoritative sources such as the responsible Swedish agency. Record the source and effective date/year near statutory constants or in the relevant documentation.
- Never silently update statutory values during unrelated work.
- Preserve full precision in calculation logic and round for display unless a domain rule explicitly requires earlier rounding.
- Use Swedish locale conventions for user-facing money, percentages, dates, and numbers.
- Clearly distinguish observed values, estimates, forecasts, hypothetical scenarios, and values synced from another tool.
- Use consistent terminology, time basis, rounding, and formulas wherever the same financial concept appears.
- Treat wording changes such as ownership share, equity, contribution, paid in, gross, and net as potential semantic changes rather than cosmetic edits.
- Add golden-value tests for material calculations, including realistic fictional Swedish household data.
- Test relevant thresholds and edge cases, including zero, missing or malformed data, rounding boundaries, and unusually large values. Test negative values when the domain permits them.
- Do not silently clamp or correct invalid financial input unless that behaviour is an explicit product decision.
- Every new or changed user-facing financial result requires automated coverage of its calculation.

## Data, privacy, and security

The application contains real household data. Production data and production administration are off limits unless the user explicitly authorises access for the specific task. Local development data and fictional seed data may be inspected and used for development.

- Never expose or commit secrets, `.env` files, private keys, session tokens, or personal financial records.
- Do not log sensitive household data.
- Do not send household data to third-party services without explicit approval.
- Do not weaken authentication, authorisation, CSP, RLS, input-safety, or household-isolation controls.
- Every new persisted entity must deliberately choose and document household-level or user-level ownership.
- Defensively validate, sanitise, and migrate persisted shapes. Migration/merge functions must be idempotent where repeated execution is possible.
- Cover relevant legacy, incomplete, and malformed persisted data with tests.
- Treat applied Supabase migrations as immutable. Create a new migration for every schema or policy change.
- Security, authentication, RLS, and schema changes require explicit approval plus relevant automated database/security tests.
- Agents may apply migrations and run read-only database checks against the local Supabase environment during an authorised task. Never apply changes to production without separate explicit approval.
- Treat local caches as resilience unless a real retry queue and conflict strategy exist. Do not claim guaranteed offline synchronisation.
- Surface save failures when data loss would matter. Silent best-effort persistence is acceptable only when harmless and intentional.

## UX and visual quality

- Design mobile-first; the primary day-to-day user often uses a phone. Use desktop space deliberately without making mobile a reduced or secondary experience.
- User-visible work must be checked at 390x844 mobile and 1440x900 desktop. Also use a 320 px-wide stress check when the change risks wrapping, clipping, dense controls, tables, or charts.
- Prevent page-level horizontal overflow. A contained chart or data region may scroll only when the affordance is clear and a better responsive representation would be misleading.
- Preserve the existing visual language, typography, green/copper palette, and shared design tokens unless the task explicitly changes them.
- Aim for contemporary Scandinavian polish, strong information hierarchy, purposeful motion, and responsive interaction. Performance and immediate usability take precedence over spectacle.
- Animations must not block interaction or delay access to important information.
- Preserve layout during loading and hydration where feasible; avoid flashes, jumps, and misleading temporary values.
- Empty states should explain the concept briefly and provide one obvious primary action.
- Prefer progressive disclosure for advanced detail while keeping important financial meaning discoverable.
- Destructive actions need a confirmation or a reliable undo appropriate to the consequence.
- Keep user-facing copy in clear, concise Swedish. Keep code, comments, test names, commit messages, and technical documentation in English.
- Use semantic controls, keyboard-operable interactions, visible focus, labelled inputs, adequate contrast, and more than colour alone to communicate meaning.

## Development workflow

### Before editing

1. Confirm the intended base branch and inspect `git status`.
2. If the worktree contains any existing tracked or untracked changes, stop and ask before editing. Never stash, discard, overwrite, or absorb them without explicit direction.
3. Start every change, including documentation and small fixes, on a new branch based on current `main`.
4. Follow established repository and planning conventions: `feat/<plan-number>-<slug>` for planned features and concise `fix/`, `refactor/`, or `docs/` branches for other work.
5. Do not work directly on `main`; pushes to `main` deploy production.

### Planning and approval

Scale planning detail to risk. Use a compact plan for ordinary, well-understood changes and a durable planning document for consequential product/design decisions.

Obtain approval before implementing:

- new product features;
- financial semantics or statutory rules;
- persisted data, schema migrations, or ownership changes;
- authentication, security, or RLS changes;
- cross-cutting architectural changes;
- material visual redesigns;
- new runtime or development dependencies;
- browser compatibility trade-offs; or
- expanded scope.

Small bug fixes with an established cause may proceed within the authorised task.

### Test-driven implementation

Use red-green-refactor as the default workflow:

1. Write or identify a test that fails for the intended reason.
2. Implement the smallest coherent change that makes it pass.
3. Refactor only within task scope while keeping the suite green.

- Every behavioural implementation must add or update appropriate tests.
- Every bug fix must include a regression test unless genuinely impractical. Explain any exception.
- Use focused tests during development, then run the complete relevant suite before completion.
- Do not rewrite tests merely to accommodate an incorrect implementation.
- If unrelated tests already fail, establish and report the pre-existing failure, then continue only if the task can still be verified safely.
- Add a DOM/component testing harness only when a concrete interaction needs it, and ask before adding the dependency.

### Required verification

For frontend changes, run from `web/`:

```sh
npm run lint
npm run test
npm run build
```

Add relevant Supabase tests, migration checks, security checks, or browser flows based on the change. Documentation-only changes do not require inventing tests, but their commands, paths, and claims must be verified against the repository.

For user-visible changes, start the local app and inspect the actual result in a browser. Verify the changed flow rather than only the landing page, including:

- mobile and desktop layouts;
- light and dark themes when relevant;
- overflow, clipping, wrapping, and touch targets;
- keyboard and focus behaviour;
- loading, empty, error, and populated states as relevant;
- animation smoothness and interaction during transitions; and
- realistic fictional data rather than production records.

Use before/after screenshots when they materially help review a visual change.

### Completion and Git

A change is complete only when:

- the requested behaviour is implemented;
- relevant new tests and the full required suite pass;
- important UI is verified on mobile and desktop;
- data and security implications are tested;
- plan deviations are disclosed; and
- remaining risks and manual checks are reported clearly.

After successful verification, commit the scoped changes with an English commit message following repository conventions. Then push the branch and open a ready-for-review PR. One feature or plan should normally map to one branch and one PR; tightly related fixes discovered during that work may be included when they do not expand its purpose.

Never merge a PR. Only the repository owner merges. Never deploy, access production data, or perform production administration without explicit separate approval.

Provide short progress updates at major milestones: investigation, implementation, verification, and decision points.
