# 密鑰管理 · Secret Management

AEON Delight OneView module. Keeps track of the **Microsoft Entra ID app registrations** behind our
SSO-enabled web apps, shows how long each client secret has left, emails warnings, and **rotates a
secret end to end without anyone touching a portal**.

Secrets expire. When one does, SSO stops for everyone on that app (`AADSTS7000215`). Until now the
register was a spreadsheet and a few `.txt` files.

Production: **https://secret.aeondelightasia.online** · Coolify project **Secret Management**

## What it does

- **Inventory** — every app registration this tool is an *Owner* of, with all its client secrets and
  certificates, their expiry dates and days remaining (green / amber / red).
- **Warnings** — email at 60 / 30 / 14 / 7 / 1 days before expiry, once per secret per threshold.
- **Rotation** — on a schedule or on demand:

  ```
  1  Entra: addPassword            new secret, 12-month lifetime by default
  2  store the value encrypted     Graph hands it over exactly once
  3  snapshot + write the Coolify environment variable(s)
  4  restart each affected application
  5  health-check the app          up to 2 minutes
  6  Entra: removePassword         the OLD secret — only now
  ```

  **The old secret stays valid for the whole run.** If anything fails at steps 3–5 the variables are
  restored from the snapshots, the application is restarted again, and the *new* secret is deleted —
  the app carries on with the old one, and you get an email saying so.
- **Per-app policy** — rotate *N days before expiry* (default 30), *monthly* on a chosen day, or
  *manual only*. New-secret lifetime is 1–24 months.
- **Several targets per app** — one registration's secret can live in more than one Coolify
  application (e.g. an app service plus a separate Supabase service).
- Sign-in, Account Management and the navbar follow the usual OneView model.

## How it works

```
                          ┌──────────────────────────┐
  Entra ID  ◄── Graph ────┤ Secret Management        ├──── Coolify REST API ────►  the app's
  (app regs)              │  • inventory + alerts    │     (PATCH one env var,     Coolify
      ▲                   │  • rotation scheduler    │      POST restart)          application
      │                   │  • Postgres (encrypted)  │                                  │
      └── addPassword /   │                          ├──── health check ────────────────┘
          removePassword  └──────────────────────────┘
```

Everything the tool can touch is opt-in twice over: Graph only exposes registrations where this
tool's service principal is an **Owner**, and a registration is only rotated once an admin has
added it here *and* given it a delivery target.

## Tables

Two schemas. `APP_SCHEMA` (default `appreg_app`) holds the OneView account tables —
`accounts`, `sessions`, `settings`, `business_units`, `account_bus`, `sso_tokens`.
`DATA_SCHEMA` (default `appreg`) holds the registry:

| Table | What it holds |
|---|---|
| `managed_apps` | one row per registration we look after, plus its rotation policy |
| `app_targets` | where the secret has to be delivered (Coolify application uuid + variable name) |
| `credentials` | every secret and certificate on the registration, refreshed from Graph; `is_current` is the one the live app uses |
| `secret_values` | AES-256-GCM copies of the secrets **this tool issued** |
| `var_snapshots` | the previous variable value, so a failed rotation can put it back |
| `rotation_runs` | one row per attempt, with a step-by-step `steps` log |
| `alerts_sent` | one row per (secret, threshold), so warnings don't repeat |
| `audit_log` | who revealed, rotated or deleted what |

## Environment variables

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — | **required**, e.g. `postgres://postgres:pwd@<db-uuid>:5432/postgres` |
| `DATABASE_SSL` | off | `1` to use TLS |
| `APP_SCHEMA` | `appreg_app` | account tables |
| `DATA_SCHEMA` | `appreg` | registry tables |
| `APP_SECRET` | random | **encrypts every stored secret. Set it once and never change it** — changing it makes stored values unreadable |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | — | seeds one Email-type admin on the first run only |
| `SSO_TENANT_ID` / `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` | — | Entra ID — used for **both** sign-in and Microsoft Graph |
| `SSO_REDIRECT_URI` | `<host>/api/auth/sso/callback` | override if needed |
| `PASSWORD_LOGIN` | `1` | `0` = Microsoft sign-in only |
| `COOLIFY_URL` / `COOLIFY_API_TOKEN` | — | optional; otherwise saved encrypted from Configuration |
| `ROTATE_ENABLED` | `1` | `0` turns the scheduler off — **keep it `0` in DEV** |
| `ROTATE_INTERVAL_MIN` | `60` | how often to check what is due |
| `HEALTH_TIMEOUT_MS` | `120000` | how long to wait for an app after restart |
| `RESTART_SETTLE_MS` | `8000` | pause after a restart before health-checking |
| `RUN_LOG_DAYS` | `180` | how long rotation runs are kept |
| `FRAME_ANCESTORS` | — | extra origins allowed to embed the module, space-separated. OneView (`https://oneview.aeondelightasia.online`) and `localhost:8090` are already allowed |
| `PORT` | `8094` | local DEV default; the Dockerfile uses `8080` inside the container |

## Local development (Docker)

```powershell
copy .env.example .env     # fill in APP_SECRET and BOOTSTRAP_ADMIN_*
docker compose up -d --build
```

Then open <http://localhost:8094> and sign in with the bootstrap admin.
(8090 OneView, 8091 PWH Attendance, 8092 Access Control Attendance and 8093 `iotwa-dash` are
already in use locally.)

The DEV compose file sets `ROTATE_ENABLED=0` deliberately: a DEV copy pointed at the real tenant
would otherwise rotate production secrets.

Postgres is published on `localhost:5435` for psql / DB Browser.

### Tests

```powershell
docker compose up -d db
npm test
```

- `tests/unit.test.js` — schedule logic, the Coolify adapter (single-key PATCH, the PATCH→POST
  fallback, unreadable values, 401/403/429 handling), alert configuration rules. No network.
- `tests/routes.test.js` — every `/api/…` call the pages make must resolve to a route in
  `server.js`. This exists because an early build shipped without the `/api/accounts` routes and
  Account Management silently rendered blank.
- `tests/rotate.test.js` — real rotations against the DEV database with Entra and Coolify stubbed.
  It asserts the thing that matters: **the old secret survives every failure path.**

## Deploy on Coolify

Server `179.197.249.13` — the only one. Project **Secret Management**.

1. New resource → **PostgreSQL** → Start. Note the container short hash: that is the internal
   hostname (`postgres://postgres:<pw>@<uuid>:5432/postgres`).
2. New resource → **Git Repository (with GitHub App)** → repository
   `terryyangaeon/aeon_secret_management`, branch `main`, **Build pack: Dockerfile**
   (Smart Scan picks *Docker Compose* because the repo has one for local DEV — that is wrong).
3. Ports exposes → `8080`.
4. Domains → `https://secret.aeondelightasia.online`, with the **Port** field filled in explicitly.
   Coolify auto-adds `www.` — remove it. DNS A record → `179.197.249.13`, **DNS only (grey cloud)**
   so Let's Encrypt HTTP-01 can complete.
5. Environment Variables → Developer View → paste into **Production**:
   `DATABASE_URL`, `APP_SECRET`, the three `SSO_*` values, and on the first
   deploy only `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. No inline `#` comments —
   Coolify strips them.
6. Deploy, then poll `https://secret.aeondelightasia.online/api/health`.

## Microsoft sign-in and Graph (one app registration does both)

At <https://entra.microsoft.com> → App registrations → **New registration**:

1. Name `AEON Secret Management`, **single tenant**, Web redirect URI
   `https://secret.aeondelightasia.online/api/auth/sso/callback`
   (add `http://localhost:8094/api/auth/sso/callback` for DEV).
2. Certificates & secrets → New client secret → copy the **Value** (not the Secret ID).
   Give this one a **24-month** lifetime — see "the tool's own secret" below.
3. API permissions → Microsoft Graph → **Application permissions**:
   - `User.Read.All` — the directory check when an admin adds an SSO account
   - `Application.ReadWrite.OwnedBy` — read and rotate secrets on owned registrations
   - `Mail.Send` — the alert emails

   then **Grant admin consent for AEON Delight Asia**. All three must show green "Granted".
   Scope `Mail.Send` to one sender mailbox with an Exchange application access policy.
4. **For every registration you want managed: open it → Owners → Add owner → this app.**
   A registration that is not owned is invisible here — it will not appear and will not be
   warned about.

## Coolify API token

Coolify → **Keys & Tokens → API Tokens**. The token needs:

| Permission | Why |
|---|---|
| `read:sensitive` | to read the current variable value and snapshot it before overwriting. Without it a rotation has nothing to roll back to, and Configuration → Test connection says so |
| `write` | to change the variable |
| `deploy` | to restart the application |

Paste it into Configuration → Coolify connection, then **Test connection**. API access must be
enabled under Settings → Advanced.

## First run, in order

1. Sign in as the bootstrap admin, add the real admins in Account Management.
   Keep one **Email-type** admin as break-glass, in case Microsoft sign-in breaks.
2. Configuration → **Coolify connection** → server URL + token → **Test connection**.
   Check it reports *Can read values: yes*.
3. Configuration → **Alerts** → sender mailbox, recipients → **Send test email**.
4. Configuration → **Applications** → Add application. Only owned registrations are listed.
   Leave **auto-rotate off** for now.
5. Configuration → **Delivery targets** → pick the app → pick the Coolify application → pick or type
   the variable that holds its secret → **Test**. There is no single naming convention:

   | App | Variable |
   |---|---|
   | Access Control Attendance, PWH Attendance Record | `SSO_CLIENT_SECRET` |
   | AEON Document Log | `AZURE_AD_CLIENT_SECRET` |
   | Work Copilot | `ENTRA_CLIENT_SECRET` |
   | ITQPOMS-Prod | on the Supabase application, `GOTRUE_EXTERNAL_AZURE_SECRET` |

6. Prove it on a **throwaway Coolify application with a dummy variable** first: Rotate now, and
   check the run log shows all seven steps.
7. Then switch auto-rotate on for one real app and watch it through one cycle before doing the rest.

## The tool's own secret

This app's own client secret is the one it cannot safely rotate: a half-failed self-rotation takes
away its own Graph access. So:

- give it a **24-month** lifetime,
- leave `auto_rotate` **off** for its own registration — it still monitors and emails about itself,
- keep the break-glass Email admin, so you can always get in and read the dashboard.

Turning self-rotation on is a deliberate choice, not the default.

## Embedding in OneView

The navbar hides itself inside OneView's iframe. The session cookie is
`HttpOnly; Secure; SameSite=None; Partitioned` on HTTPS, and `Content-Security-Policy:
frame-ancestors` allows `'self'`, **`https://oneview.aeondelightasia.online`** (OneView moved off
Zeabur to the VPS in Nov 2026) and `http://localhost:8090` for OneView DEV. Anything else goes in
`FRAME_ANCESTORS`, space-separated.

Then, in OneView → Configuration, point the module's tile at
`https://secret.aeondelightasia.online`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No SSO button in production | Variables set but the app wasn't redeployed; the log says `Microsoft sign-in not configured` |
| "未獲授權使用本系統" after Microsoft sign-in | No active **SSO-type** account with that email in *this* environment's database |
| Configuration → Applications is empty | This tool isn't an **Owner** of any registration yet, or `Application.ReadWrite.OwnedBy` wasn't consented |
| "Not allowed to read/modify app registrations" | The Graph permission is missing or consent wasn't granted; it can take a few minutes after consent |
| Coolify test says *Can read values: no* | The token lacks `read:sensitive`. Rotation would work but could not roll a variable back — fix the token first |
| Coolify "rejected the API token" | Token wrong, expired, revoked, or API access disabled under Settings → Advanced |
| A run stuck on `running` | A redeploy interrupted it; `releaseStaleRuns()` closes it after 30 minutes |
| "Stored value can't be decrypted" | `APP_SECRET` changed since it was saved |
