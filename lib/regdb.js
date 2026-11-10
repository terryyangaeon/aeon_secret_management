// Registry database — the apps we manage, where their secret has to be
// delivered, the credentials we know about, and the rotation history.
// Separate schema (DATA_SCHEMA, default "appreg") from the accounts tables in
// lib/appdb.js, which owns the pool.
const appdb = require("./appdb");
const secret = require("./secret");

const SCHEMA = process.env.DATA_SCHEMA || "appreg";
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error("DATA_SCHEMA must be a lowercase identifier");
const S = '"' + SCHEMA + '"';
const q = appdb.q;

async function init() {
  await q(`CREATE SCHEMA IF NOT EXISTS ${S}`);
  await q(`
    -- An Entra app registration we look after.
    CREATE TABLE IF NOT EXISTS ${S}.managed_apps (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      entra_object_id   TEXT NOT NULL UNIQUE,
      client_id         TEXT NOT NULL DEFAULT '',
      app_url           TEXT NOT NULL DEFAULT '',
      owner_email       TEXT NOT NULL DEFAULT '',
      notes             TEXT NOT NULL DEFAULT '',
      auto_rotate       BOOLEAN NOT NULL DEFAULT FALSE,
      rotation_mode     TEXT NOT NULL DEFAULT 'expiry',  -- 'expiry' | 'monthly' | 'manual'
      rotate_before_days INTEGER NOT NULL DEFAULT 30,
      monthly_day       INTEGER NOT NULL DEFAULT 1,
      lifetime_months   INTEGER NOT NULL DEFAULT 12,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      last_rotated_at   TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Where the secret value has to end up. One app may have several (e.g. the
    -- app service and a separate Supabase service that also holds the secret).
    CREATE TABLE IF NOT EXISTS ${S}.app_targets (
      id                     SERIAL PRIMARY KEY,
      app_id                 INTEGER NOT NULL REFERENCES ${S}.managed_apps(id) ON DELETE CASCADE,
      kind                   TEXT NOT NULL DEFAULT 'coolify',
      label                  TEXT NOT NULL DEFAULT '',
      app_uuid               TEXT NOT NULL DEFAULT '',   -- Coolify application uuid
      app_name               TEXT NOT NULL DEFAULT '',
      var_name               TEXT NOT NULL,
      restart                BOOLEAN NOT NULL DEFAULT TRUE,
      health_url             TEXT NOT NULL DEFAULT '',
      sort_order             INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS app_targets_app ON ${S}.app_targets (app_id);

    -- Inventory of every secret / certificate on the registration, refreshed
    -- from Graph. is_current marks the one the live app is believed to use.
    CREATE TABLE IF NOT EXISTS ${S}.credentials (
      app_id       INTEGER NOT NULL REFERENCES ${S}.managed_apps(id) ON DELETE CASCADE,
      key_id       TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'secret',   -- 'secret' | 'certificate'
      display_name TEXT NOT NULL DEFAULT '',
      hint         TEXT NOT NULL DEFAULT '',
      starts_at    TIMESTAMPTZ,
      ends_at      TIMESTAMPTZ,
      is_current   BOOLEAN NOT NULL DEFAULT FALSE,
      created_here BOOLEAN NOT NULL DEFAULT FALSE,   -- this tool issued it
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (app_id, key_id)
    );

    -- Secret values this tool created, encrypted at rest (lib/secret.js).
    CREATE TABLE IF NOT EXISTS ${S}.secret_values (
      app_id     INTEGER NOT NULL REFERENCES ${S}.managed_apps(id) ON DELETE CASCADE,
      key_id     TEXT NOT NULL,
      value_enc  TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (app_id, key_id)
    );

    -- One attempt at rotating one app.
    CREATE TABLE IF NOT EXISTS ${S}.rotation_runs (
      id          SERIAL PRIMARY KEY,
      app_id      INTEGER NOT NULL REFERENCES ${S}.managed_apps(id) ON DELETE CASCADE,
      trigger     TEXT NOT NULL DEFAULT 'schedule',   -- 'schedule' | 'manual'
      status      TEXT NOT NULL DEFAULT 'running',    -- running | ok | error | rolled_back
      actor       TEXT NOT NULL DEFAULT '',
      old_key_id  TEXT NOT NULL DEFAULT '',
      new_key_id  TEXT NOT NULL DEFAULT '',
      steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
      error       TEXT NOT NULL DEFAULT '',
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS rotation_runs_app ON ${S}.rotation_runs (app_id, started_at DESC);

    -- Previous value of each target variable, so a failed rotation can put it back.
    CREATE TABLE IF NOT EXISTS ${S}.var_snapshots (
      run_id     INTEGER NOT NULL REFERENCES ${S}.rotation_runs(id) ON DELETE CASCADE,
      target_id  INTEGER NOT NULL,
      value_enc  TEXT NOT NULL DEFAULT '',
      had_value  BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (run_id, target_id)
    );

    -- One email per (credential, threshold), so warnings don't repeat daily.
    CREATE TABLE IF NOT EXISTS ${S}.alerts_sent (
      app_id    INTEGER NOT NULL REFERENCES ${S}.managed_apps(id) ON DELETE CASCADE,
      key_id    TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (app_id, key_id, threshold)
    );

    CREATE TABLE IF NOT EXISTS ${S}.audit_log (
      id     SERIAL PRIMARY KEY,
      at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      email  TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS audit_log_at ON ${S}.audit_log (at DESC);
  `);

  // Delivery targets were Zeabur (project / environment / service) before the
  // estate moved to Coolify, where one application uuid identifies the target.
  // Idempotent, and safe on a fresh database where none of this exists.
  await q(`
    ALTER TABLE ${S}.app_targets ADD COLUMN IF NOT EXISTS app_uuid TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${S}.app_targets ADD COLUMN IF NOT EXISTS app_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${S}.app_targets DROP COLUMN IF EXISTS zeabur_project_id;
    ALTER TABLE ${S}.app_targets DROP COLUMN IF EXISTS zeabur_project_name;
    ALTER TABLE ${S}.app_targets DROP COLUMN IF EXISTS zeabur_environment_id;
    ALTER TABLE ${S}.app_targets DROP COLUMN IF EXISTS zeabur_service_id;
    ALTER TABLE ${S}.app_targets DROP COLUMN IF EXISTS zeabur_service_name;
    UPDATE ${S}.app_targets SET kind = 'coolify' WHERE kind <> 'coolify';
  `);
}

// ---- Managed apps -----------------------------------------------------------

const MODES = ["expiry", "monthly", "manual"];
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n));
};

function appFields(a) {
  return {
    name: String(a.name || "").trim(),
    entra_object_id: String(a.entraObjectId || a.entra_object_id || "").trim(),
    client_id: String(a.clientId || a.client_id || "").trim(),
    app_url: String(a.appUrl || a.app_url || "").trim(),
    owner_email: String(a.ownerEmail || a.owner_email || "").trim().toLowerCase(),
    notes: String(a.notes || ""),
    auto_rotate: !!a.autoRotate,
    rotation_mode: MODES.indexOf(a.rotationMode) >= 0 ? a.rotationMode : "expiry",
    rotate_before_days: clampInt(a.rotateBeforeDays, 1, 180, 30),
    monthly_day: clampInt(a.monthlyDay, 1, 28, 1),
    lifetime_months: clampInt(a.lifetimeMonths, 1, 24, 12),
    active: a.active !== false,
  };
}

const listApps = () => q(`SELECT * FROM ${S}.managed_apps ORDER BY active DESC, name`);
const getApp = async (id) => (await q(`SELECT * FROM ${S}.managed_apps WHERE id = $1`, [id]))[0] || null;
const getAppByObjectId = async (oid) => (await q(`SELECT * FROM ${S}.managed_apps WHERE entra_object_id = $1`, [oid]))[0] || null;

async function createApp(a) {
  const f = appFields(a);
  if (!f.name) throw new Error("Application name is required.");
  if (!f.entra_object_id) throw new Error("Entra object id is required.");
  const r = await q(`INSERT INTO ${S}.managed_apps
      (name, entra_object_id, client_id, app_url, owner_email, notes, auto_rotate, rotation_mode,
       rotate_before_days, monthly_day, lifetime_months, active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [f.name, f.entra_object_id, f.client_id, f.app_url, f.owner_email, f.notes, f.auto_rotate,
     f.rotation_mode, f.rotate_before_days, f.monthly_day, f.lifetime_months, f.active]);
  return r[0];
}

async function updateApp(id, a) {
  const f = appFields(a);
  if (!f.name) throw new Error("Application name is required.");
  const r = await q(`UPDATE ${S}.managed_apps SET
      name=$2, client_id=$3, app_url=$4, owner_email=$5, notes=$6, auto_rotate=$7, rotation_mode=$8,
      rotate_before_days=$9, monthly_day=$10, lifetime_months=$11, active=$12
    WHERE id = $1 RETURNING *`,
    [id, f.name, f.client_id, f.app_url, f.owner_email, f.notes, f.auto_rotate, f.rotation_mode,
     f.rotate_before_days, f.monthly_day, f.lifetime_months, f.active]);
  if (!r[0]) throw new Error("No such application.");
  return r[0];
}

const deleteApp = (id) => q(`DELETE FROM ${S}.managed_apps WHERE id = $1`, [id]);
const touchRotated = (id) => q(`UPDATE ${S}.managed_apps SET last_rotated_at = NOW() WHERE id = $1`, [id]);

// ---- Delivery targets -------------------------------------------------------

function targetFields(t) {
  return {
    kind: "coolify",
    label: String(t.label || "").trim(),
    app_uuid: String(t.appUuid || t.app_uuid || "").trim(),
    app_name: String(t.appName || t.app_name || "").trim(),
    var_name: String(t.varName || t.var_name || "").trim(),
    restart: t.restart !== false,
    health_url: String(t.healthUrl || t.health_url || "").trim(),
    sort_order: clampInt(t.sortOrder, 0, 999, 0),
  };
}

const listTargets = (appId) => q(`SELECT * FROM ${S}.app_targets WHERE app_id = $1 ORDER BY sort_order, id`, [appId]);
const getTarget = async (id) => (await q(`SELECT * FROM ${S}.app_targets WHERE id = $1`, [id]))[0] || null;

async function createTarget(appId, t) {
  const f = targetFields(t);
  if (!f.var_name) throw new Error("Variable name is required.");
  if (!f.app_uuid) throw new Error("請選擇 Coolify 應用程式。 · Pick the Coolify application that holds this variable.");
  const r = await q(`INSERT INTO ${S}.app_targets
      (app_id, kind, label, app_uuid, app_name, var_name, restart, health_url, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [appId, f.kind, f.label, f.app_uuid, f.app_name, f.var_name, f.restart, f.health_url, f.sort_order]);
  return r[0];
}

async function updateTarget(id, t) {
  const f = targetFields(t);
  if (!f.var_name) throw new Error("Variable name is required.");
  const r = await q(`UPDATE ${S}.app_targets SET
      label=$2, app_uuid=$3, app_name=$4,
      var_name=$5, restart=$6, health_url=$7, sort_order=$8
    WHERE id = $1 RETURNING *`,
    [id, f.label, f.app_uuid, f.app_name, f.var_name, f.restart, f.health_url, f.sort_order]);
  if (!r[0]) throw new Error("No such target.");
  return r[0];
}

const deleteTarget = (id) => q(`DELETE FROM ${S}.app_targets WHERE id = $1`, [id]);

// ---- Credentials ------------------------------------------------------------

const listCredentials = (appId) =>
  q(`SELECT * FROM ${S}.credentials WHERE app_id = $1 ORDER BY ends_at NULLS LAST, key_id`, [appId]);

// Replace the known credential set for one app with what Graph just reported.
// Keeps is_current / created_here, and drops rows Entra no longer has.
async function syncCredentials(appId, creds) {
  const seen = [];
  for (const c of creds) {
    seen.push(c.keyId);
    await q(`INSERT INTO ${S}.credentials (app_id, key_id, kind, display_name, hint, starts_at, ends_at, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
             ON CONFLICT (app_id, key_id) DO UPDATE SET
               kind = EXCLUDED.kind, display_name = EXCLUDED.display_name, hint = EXCLUDED.hint,
               starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, last_seen_at = NOW()`,
      [appId, c.keyId, c.kind || "secret", c.displayName || "", c.hint || "", c.startsAt, c.endsAt]);
  }
  if (seen.length) await q(`DELETE FROM ${S}.credentials WHERE app_id = $1 AND key_id <> ALL($2::text[])`, [appId, seen]);
  else await q(`DELETE FROM ${S}.credentials WHERE app_id = $1`, [appId]);

  // Nothing marked current (first sync, or the current one was deleted in
  // Entra) → assume the live app uses the secret that expires last.
  const cur = await q(`SELECT 1 FROM ${S}.credentials WHERE app_id = $1 AND is_current`, [appId]);
  if (!cur.length) {
    await q(`UPDATE ${S}.credentials SET is_current = TRUE WHERE (app_id, key_id) = (
               SELECT app_id, key_id FROM ${S}.credentials
               WHERE app_id = $1 AND kind = 'secret' ORDER BY ends_at DESC NULLS LAST LIMIT 1)`, [appId]);
  }
  return listCredentials(appId);
}

async function setCurrent(appId, keyId) {
  await q(`UPDATE ${S}.credentials SET is_current = (key_id = $2) WHERE app_id = $1`, [appId, String(keyId)]);
}

const currentCredential = async (appId) =>
  (await q(`SELECT * FROM ${S}.credentials WHERE app_id = $1 AND is_current LIMIT 1`, [appId]))[0] || null;

const markCreatedHere = (appId, keyId) =>
  q(`UPDATE ${S}.credentials SET created_here = TRUE WHERE app_id = $1 AND key_id = $2`, [appId, String(keyId)]);

async function addCredentialRow(appId, c) {
  await q(`INSERT INTO ${S}.credentials (app_id, key_id, kind, display_name, hint, starts_at, ends_at, created_here, last_seen_at)
           VALUES ($1,$2,'secret',$3,'',NOW(),$4,TRUE,NOW())
           ON CONFLICT (app_id, key_id) DO UPDATE SET created_here = TRUE, ends_at = EXCLUDED.ends_at`,
    [appId, c.keyId, c.displayName || "", c.endsAt]);
}

const deleteCredentialRow = (appId, keyId) =>
  q(`DELETE FROM ${S}.credentials WHERE app_id = $1 AND key_id = $2`, [appId, String(keyId)]);

// ---- Secret values (encrypted) ----------------------------------------------

async function saveSecretValue(appId, keyId, value) {
  const enc = await secret.encrypt(String(value));
  await q(`INSERT INTO ${S}.secret_values (app_id, key_id, value_enc) VALUES ($1,$2,$3)
           ON CONFLICT (app_id, key_id) DO UPDATE SET value_enc = EXCLUDED.value_enc, created_at = NOW()`,
    [appId, String(keyId), enc]);
}

async function readSecretValue(appId, keyId) {
  const r = await q(`SELECT value_enc FROM ${S}.secret_values WHERE app_id = $1 AND key_id = $2`, [appId, String(keyId)]);
  if (!r[0]) return null;
  return secret.decrypt(r[0].value_enc);
}

const hasSecretValue = async (appId, keyId) =>
  !!(await q(`SELECT 1 FROM ${S}.secret_values WHERE app_id = $1 AND key_id = $2`, [appId, String(keyId)]))[0];

const deleteSecretValue = (appId, keyId) =>
  q(`DELETE FROM ${S}.secret_values WHERE app_id = $1 AND key_id = $2`, [appId, String(keyId)]);

// ---- Rotation runs ----------------------------------------------------------

async function startRun(appId, trigger, actor) {
  const r = await q(`INSERT INTO ${S}.rotation_runs (app_id, trigger, actor) VALUES ($1,$2,$3) RETURNING id`,
    [appId, trigger === "manual" ? "manual" : "schedule", String(actor || "")]);
  return r[0].id;
}

// Steps are appended one at a time so a crashed run still shows how far it got.
async function step(runId, name, ok, detail) {
  const s = { at: new Date().toISOString(), step: name, ok: !!ok };
  if (detail) s.detail = String(detail).slice(0, 500);
  await q(`UPDATE ${S}.rotation_runs SET steps = steps || $2::jsonb WHERE id = $1`, [runId, JSON.stringify([s])]);
  return s;
}

async function finishRun(runId, r) {
  await q(`UPDATE ${S}.rotation_runs SET status=$2, error=$3, old_key_id=$4, new_key_id=$5, finished_at=NOW() WHERE id=$1`,
    [runId, r.status, String(r.error || "").slice(0, 2000), String(r.oldKeyId || ""), String(r.newKeyId || "")]);
}

function listRuns(opts) {
  const o = opts || {};
  const lim = clampInt(o.limit, 1, 500, 50);
  if (o.appId) return q(`SELECT r.*, a.name AS app_name FROM ${S}.rotation_runs r
    JOIN ${S}.managed_apps a ON a.id = r.app_id WHERE r.app_id = $1 ORDER BY r.started_at DESC LIMIT ${lim}`, [o.appId]);
  return q(`SELECT r.*, a.name AS app_name FROM ${S}.rotation_runs r
    JOIN ${S}.managed_apps a ON a.id = r.app_id ORDER BY r.started_at DESC LIMIT ${lim}`);
}

const getRun = async (id) => (await q(`SELECT * FROM ${S}.rotation_runs WHERE id = $1`, [id]))[0] || null;
const pruneRuns = (days) => q(`DELETE FROM ${S}.rotation_runs WHERE started_at < NOW() - ($1 || ' days')::interval`, [String(days)]);

// A run left 'running' by a crash or redeploy would block the app forever.
const releaseStaleRuns = () =>
  q(`UPDATE ${S}.rotation_runs SET status='error', error='Interrupted — the service restarted during this rotation.', finished_at=NOW()
     WHERE status='running' AND started_at < NOW() - interval '30 minutes'`);

// ---- Variable snapshots (for rollback) --------------------------------------

async function saveSnapshot(runId, targetId, value) {
  const had = value !== null && value !== undefined;
  await q(`INSERT INTO ${S}.var_snapshots (run_id, target_id, value_enc, had_value) VALUES ($1,$2,$3,$4)
           ON CONFLICT (run_id, target_id) DO UPDATE SET value_enc = EXCLUDED.value_enc, had_value = EXCLUDED.had_value`,
    [runId, targetId, had ? await secret.encrypt(String(value)) : "", had]);
}

async function readSnapshot(runId, targetId) {
  const r = await q(`SELECT value_enc, had_value FROM ${S}.var_snapshots WHERE run_id = $1 AND target_id = $2`, [runId, targetId]);
  if (!r[0] || !r[0].had_value) return null;
  return secret.decrypt(r[0].value_enc);
}

// ---- Alerts & audit ---------------------------------------------------------

// true the first time only — INSERT ... ON CONFLICT DO NOTHING is the lock.
async function claimAlert(appId, keyId, threshold) {
  const r = await q(`INSERT INTO ${S}.alerts_sent (app_id, key_id, threshold) VALUES ($1,$2,$3)
                     ON CONFLICT DO NOTHING RETURNING 1`, [appId, String(keyId), threshold]);
  return !!r[0];
}

const clearAlerts = (appId, keyId) =>
  q(`DELETE FROM ${S}.alerts_sent WHERE app_id = $1 AND key_id = $2`, [appId, String(keyId)]);

const audit = (email, action, target, detail) =>
  q(`INSERT INTO ${S}.audit_log (email, action, target, detail) VALUES ($1,$2,$3,$4)`,
    [String(email || ""), String(action), String(target || ""), JSON.stringify(detail || {})])
    .catch((e) => console.warn("audit failed:", e.message));

const listAudit = (limit) =>
  q(`SELECT * FROM ${S}.audit_log ORDER BY at DESC LIMIT ${clampInt(limit, 1, 500, 100)}`);

module.exports = {
  SCHEMA, init,
  listApps, getApp, getAppByObjectId, createApp, updateApp, deleteApp, touchRotated,
  listTargets, getTarget, createTarget, updateTarget, deleteTarget,
  listCredentials, syncCredentials, setCurrent, currentCredential, markCreatedHere,
  addCredentialRow, deleteCredentialRow,
  saveSecretValue, readSecretValue, hasSecretValue, deleteSecretValue,
  startRun, step, finishRun, listRuns, getRun, pruneRuns, releaseStaleRuns,
  saveSnapshot, readSnapshot,
  claimAlert, clearAlerts, audit, listAudit,
};
