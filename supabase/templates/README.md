# Auth email templates

Branded Swedish versions of the six Supabase Auth emails. These files are the
source of truth. `supabase/config.toml` points local dev (Inbucket) at them;
production only gets them when the owner pastes them into the dashboard.

**Never run `supabase config push`.** It pushes the whole local `config.toml`,
including `site_url = "http://127.0.0.1:3000"`, and breaks production login.

| File | Subject |
|---|---|
| `magic_link.html` | `Logga in på Hemma OS` |
| `confirmation.html` | `Välkommen till Hemma OS` |
| `invite.html` | `Du är inbjuden till Hemma OS` |
| `email_change.html` | `Bekräfta din nya e-postadress` |
| `recovery.html` | `Logga in på Hemma OS igen` |
| `reauthentication.html` | `Din bekräftelsekod` |

## Runbook

1. **Preview locally:** run `supabase stop && supabase start`, request a link on
   `localhost:5174` with a test address, and open Inbucket at
   `http://127.0.0.1:54324`. Check light and dark (macOS Mail / iOS Mail
   preview, or Inbucket's HTML view).
2. **Production, per template:** Dashboard -> Authentication -> Emails ->
   Templates -> pick the type -> set **Subject** from the table above -> paste
   the file's full HTML into the body -> Save.
3. **Smoke test immediately** with your own address. The magic link should
   arrive in Swedish from `inloggning@mail.vardon-family.se`, the button should
   log you in, and the fallback URL should be visible. If anything is wrong, the
   dashboard's **Reset to default** is the rollback.
4. **Never run `supabase config push`.**

## Rules enforced by `web/src/lib/auth-email-templates.test.ts`

- No images, web fonts or other remote resources; all styles inline.
- Only variables the template type supports; `{{ .Token }}` only in
  `reauthentication.html`.
- `{{ .ConfirmationURL }}` appears twice (button and visible fallback).
- Every mail says why it was sent and that it cannot be replied to.
