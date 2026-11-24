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
      lifetime_months   INTEGER NOT NULL DEFAULT 6,    -- tenant policy caps secrets at 6 months
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

    -- The same once-per-threshold rule for registrations that are NOT tracked
    -- here. They have no managed_apps row, so they cannot use alerts_sent;
    -- keyed on the Entra object id instead.
    CREATE TABLE IF NOT EXISTS ${S}.untracked_alerts_sent (
      object_id TEXT NOT NULL,
      key_id    TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (object_id, key_id, threshold)
    );
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
    UPDATE ${S}.app_targets SET kind = 'coolify' WHERE kind NOT IN ('coolify', 'supabase');
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS ${S}.coolify_connections (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      base_url    TEXT NOT NULL DEFAULT '',
      token_enc   TEXT NOT NULL DEFAULT '',
      from_env    BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${S}.app_targets ADD COLUMN IF NOT EXISTS coolify_connection_id INTEGER REFERENCES ${S}.coolify_connections(id);
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS ${S}.supabase_connections (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      endpoint_url  TEXT NOT NULL DEFAULT '',
      token_enc     TEXT NOT NULL DEFAULT '',
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${S}.app_targets ADD COLUMN IF NOT EXISTS supabase_connection_id INTEGER REFERENCES ${S}.supabase_connections(id);
    ALTER TABLE ${S}.app_targets ADD COLUMN IF NOT EXISTS supabase_target TEXT NOT NULL DEFAULT 'secret';
  `);
  await migrateCoolifyConnections();
}

function normCoolifyUrl(u) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/api\/v1$/i, "");
}

// One-time import from the old single-setting row or COOLIFY_* env vars; then
// attach any target still missing a connection to the default row.
async function migrateCoolifyConnections() {
  const n = await q(`SELECT count(*)::int AS n FROM ${S}.coolify_connections`);
  if (n[0].n === 0) {
    const envUrl = process.env.COOLIFY_URL || "";
    const envTok = process.env.COOLIFY_API_TOKEN || "";
    if (envUrl && envTok) {
      await q(`INSERT INTO ${S}.coolify_connections (name, base_url, token_enc, from_env, sort_order)
               VALUES ($1,$2,$3,TRUE,0)`,
        ["Environment (COOLIFY_URL)", normCoolifyUrl(envUrl), ""]);
    } else {
      const legacy = await appdb.getSetting("coolify", null);
      if (legacy && legacy.baseUrl) {
        await q(`INSERT INTO ${S}.coolify_connections (name, base_url, token_enc, from_env, sort_order)
                 VALUES ($1,$2,$3,FALSE,0)`,
          ["Primary", normCoolifyUrl(legacy.baseUrl), legacy.enc || ""]);
      }
    }
  }
  const first = await q(`SELECT id FROM ${S}.coolify_connections ORDER BY sort_order, id LIMIT 1`);
  if (first[0]) {
    await q(`UPDATE ${S}.app_targets SET coolify_connection_id = $1
             WHERE coolify_connection_id IS NULL AND kind = 'coolify'`, [first[0].id]);
  }
}

// ---- Managed apps -----------------------------------------------------------

const MODES = ["expiry", "monthly", "manual"];
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n));
};

// The tenant application-management policy refuses addPassword at 6 months or
// longer. Configuration Save and both app APIs reject that; they do not clamp
// it down to a different value. Whole months, minimum 1, maximum 5.
const LIFETIME_MONTHS_ERROR =
  "新密碼有效期必須是 1 至 5 個月（少於 6）。6 個月或以上會被租戶的應用程式管理政策拒絕，Entra 不會建立該密碼。 · " +
  "New secret validity must be 1 to 5 months (less than 6). 6 months or more is rejected by the tenant application-management policy, and Entra will not create the secret.";

function lifetimeMonthsValue(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return NaN;
}

function assertLifetimeMonths(v) {
  const n = lifetimeMonthsValue(v);
  if (!(n >= 1 && n < 6)) {
    throw Object.assign(new Error(LIFETIME_MONTHS_ERROR), { status: 400, code: "lifetime_months" });
  }
  return n;
}

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
    // API saves reject anything outside 1–5 via assertLifetimeMonths. This clamp
    // stays wider so inventory refresh can rewrite a row saved before the cap
    // without changing the lifetime already stored on it.
    lifetime_months: clampInt(a.lifetimeMonths, 1, 24, 6),
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

function supabaseAuthVarName(v) {
  const s = String(v || "").trim();
  if (/^external_azure_secret$/i.test(s)) return true;
  if (/^auth:\s*azure/i.test(s)) return true;
  return false;
}

function isSupabaseAzureAuthTarget(t) {
  if (!t || String(t.kind || "").toLowerCase() !== "supabase") return false;
  if (String(t.supabase_target || t.supabaseTarget || "").toLowerCase() === "azure_auth") return true;
  return supabaseAuthVarName(t.var_name || t.varName);
}

function targetFields(t) {
  const kind = String(t.kind || "coolify").toLowerCase() === "supabase" ? "supabase" : "coolify";
  const label = String(t.label || "").trim();
  const varName = String(t.varName || t.var_name || "").trim();
  const health = String(t.healthUrl || t.health_url || "").trim();
  const sort = clampInt(t.sortOrder, 0, 999, 0);
  if (kind === "supabase") {
    const conn = parseInt(t.supabaseConnectionId || t.supabase_connection_id, 10);
    const slot = isSupabaseAzureAuthTarget({ kind: "supabase", supabase_target: t.supabaseTarget || t.supabase_target, var_name: varName })
      ? "azure_auth" : "secret";
    return {
      kind, label,
      coolify_connection_id: null,
      supabase_connection_id: conn,
      app_uuid: "",
      app_name: String(t.appName || t.app_name || "").trim(),
      var_name: slot === "azure_auth" ? "external_azure_secret" : varName,
      restart: false,
      health_url: health,
      sort_order: sort,
      supabase_target: slot,
    };
  }
  const conn = parseInt(t.coolifyConnectionId || t.coolify_connection_id, 10);
  return {
    kind, label,
    coolify_connection_id: conn,
    supabase_connection_id: null,
    app_uuid: String(t.appUuid || t.app_uuid || "").trim(),
    app_name: String(t.appName || t.app_name || "").trim(),
    var_name: varName,
    restart: t.restart !== false,
    health_url: health,
    sort_order: sort,
    supabase_target: "secret",
  };
}

const listTargets = (appId) =>
  q(`SELECT t.*, c.name AS coolify_connection_name, c.base_url AS coolify_connection_url,
            s.name AS supabase_connection_name, s.endpoint_url AS supabase_connection_url
     FROM ${S}.app_targets t
     LEFT JOIN ${S}.coolify_connections c ON c.id = t.coolify_connection_id
     LEFT JOIN ${S}.supabase_connections s ON s.id = t.supabase_connection_id
     WHERE t.app_id = $1 ORDER BY t.sort_order, t.id`, [appId]);
const getTarget = async (id) => (await q(`SELECT * FROM ${S}.app_targets WHERE id = $1`, [id]))[0] || null;

async function assertTargetConnection(f) {
  if (f.kind === "supabase") {
    if (!f.supabase_connection_id || f.supabase_connection_id < 1) {
      throw Object.assign(new Error("請選擇 Supabase 連線。 · Pick the Supabase connection for this delivery target."), { status: 400 });
    }
    const c = await getSupabaseConnection(f.supabase_connection_id);
    if (!c) throw Object.assign(new Error("No such Supabase connection."), { status: 400 });
    return;
  }
  if (!f.coolify_connection_id || f.coolify_connection_id < 1) {
    throw Object.assign(new Error("請選擇 Coolify 連線。 · Pick the Coolify connection for this delivery target."), { status: 400 });
  }
  const c = await getCoolifyConnection(f.coolify_connection_id);
  if (!c) throw Object.assign(new Error("No such Coolify connection."), { status: 400 });
}

async function assertTargetUnique(appId, f, exceptId) {
  const rows = f.kind === "supabase"
    ? await q(
      `SELECT id FROM ${S}.app_targets WHERE app_id = $1 AND kind = 'supabase' AND supabase_connection_id = $2 AND var_name = $3 AND supabase_target = $4`
        + (exceptId ? " AND id <> $5" : ""),
      exceptId ? [appId, f.supabase_connection_id, f.var_name, f.supabase_target, exceptId]
        : [appId, f.supabase_connection_id, f.var_name, f.supabase_target])
    : await q(
      `SELECT id FROM ${S}.app_targets WHERE app_id = $1 AND coolify_connection_id = $2 AND app_uuid = $3 AND var_name = $4`
        + (exceptId ? " AND id <> $5" : ""),
      exceptId ? [appId, f.coolify_connection_id, f.app_uuid, f.var_name, exceptId]
        : [appId, f.coolify_connection_id, f.app_uuid, f.var_name]);
  if (rows.length) {
    throw Object.assign(new Error(
      f.kind === "supabase"
        ? "同一個 Supabase 連線上不能有兩行相同的環境變數。 · The same Supabase connection and variable are already configured."
        : "同一個 Coolify 連線上不能有兩行相同的應用程式和環境變數。 · The same Coolify connection, application, and variable are already configured."),
    { status: 409 });
  }
}

async function createTarget(appId, t) {
  const f = targetFields(t);
  if (!f.var_name) throw new Error("Variable name is required.");
  if (f.kind !== "supabase" && !f.app_uuid) throw new Error("請選擇 Coolify 應用程式。 · Pick the Coolify application that holds this variable.");
  await assertTargetConnection(f);
  await assertTargetUnique(appId, f, 0);
  const r = await q(`INSERT INTO ${S}.app_targets
      (app_id, kind, label, coolify_connection_id, supabase_connection_id, app_uuid, app_name, var_name, restart, health_url, sort_order, supabase_target)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [appId, f.kind, f.label, f.coolify_connection_id, f.supabase_connection_id, f.app_uuid, f.app_name, f.var_name, f.restart, f.health_url, f.sort_order, f.supabase_target]);
  return r[0];
}

async function updateTarget(id, t) {
  const f = targetFields(t);
  if (!f.var_name) throw new Error("Variable name is required.");
  if (f.kind !== "supabase" && !f.app_uuid) throw new Error("請選擇 Coolify 應用程式。 · Pick the Coolify application that holds this variable.");
  const prev = await getTarget(id);
  if (!prev) throw new Error("No such target.");
  await assertTargetConnection(f);
  await assertTargetUnique(prev.app_id, f, id);
  const r = await q(`UPDATE ${S}.app_targets SET
      kind=$2, label=$3, coolify_connection_id=$4, supabase_connection_id=$5, app_uuid=$6, app_name=$7,
      var_name=$8, restart=$9, health_url=$10, sort_order=$11, supabase_target=$12
    WHERE id = $1 RETURNING *`,
  [id, f.kind, f.label, f.coolify_connection_id, f.supabase_connection_id, f.app_uuid, f.app_name, f.var_name, f.restart, f.health_url, f.sort_order, f.supabase_target]);
  if (!r[0]) throw new Error("No such target.");
  return r[0];
}

const deleteTarget = (id) => q(`DELETE FROM ${S}.app_targets WHERE id = $1`, [id]);

// ---- Coolify connections ----------------------------------------------------

function connectionPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    fromEnv: !!row.from_env,
    hasToken: !!row.from_env || !!(row.token_enc && String(row.token_enc).length),
    sortOrder: row.sort_order,
    targetCount: row.target_count != null ? row.target_count : undefined,
  };
}

// First three characters plus the length, so the page can mask the rest.
// The plaintext itself is never attached to the object this returns.
function tokenMask(token) {
  const t = String(token || "");
  return { tokenPreview: t.slice(0, 3), tokenLength: t.length };
}

function withTokenPreview(pub, token) {
  if (!pub) return null;
  const m = tokenMask(token);
  const out = Object.assign({}, pub, { tokenPreview: m.tokenPreview, tokenLength: m.tokenLength });
  delete out.token;
  delete out.token_enc;
  delete out.enc;
  return out;
}

async function readCoolifyToken(row) {
  if (!row) return "";
  if (row.from_env) return String(process.env.COOLIFY_API_TOKEN || "");
  if (!row.token_enc) return "";
  return secret.decrypt(row.token_enc);
}

async function coolifyConnectionView(row) {
  const pub = connectionPublic(row);
  if (!pub) return null;
  let plain = "";
  try { plain = await readCoolifyToken(row); } catch (e) { plain = ""; }
  return withTokenPreview(pub, plain);
}

const listCoolifyConnections = async () => {
  const rows = await q(
    `SELECT c.*, (SELECT count(*)::int FROM ${S}.app_targets t WHERE t.coolify_connection_id = c.id) AS target_count
     FROM ${S}.coolify_connections c ORDER BY c.sort_order, c.id`,
  );
  return rows;
};

const getCoolifyConnection = async (id) =>
  (await q(`SELECT * FROM ${S}.coolify_connections WHERE id = $1`, [id]))[0] || null;

async function createCoolifyConnection(c) {
  const name = String(c.name || "").trim();
  const baseUrl = normCoolifyUrl(c.baseUrl || c.base_url || "");
  if (!name) throw Object.assign(new Error("Connection name is required."), { status: 400 });
  if (!baseUrl) throw Object.assign(new Error("Coolify URL is required."), { status: 400 });
  const t = String(c.token || "").trim();
  if (!t) throw Object.assign(new Error("Coolify API token is required."), { status: 400 });
  const r = await q(
    `INSERT INTO ${S}.coolify_connections (name, base_url, token_enc, from_env, sort_order)
     VALUES ($1,$2,$3,FALSE,(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ${S}.coolify_connections)) RETURNING *`,
    [name, baseUrl, await secret.encrypt(t)],
  );
  return r[0];
}

async function updateCoolifyConnection(id, c) {
  const row = await getCoolifyConnection(id);
  if (!row) throw Object.assign(new Error("No such Coolify connection."), { status: 404 });
  if (row.from_env) {
    throw Object.assign(new Error(
      "此連線由 COOLIFY_URL / COOLIFY_API_TOKEN 環境變數提供,請在該處修改。 · " +
      "This connection comes from the COOLIFY_URL / COOLIFY_API_TOKEN environment variables — change it there."), { status: 400 });
  }
  const name = String(c.name || row.name).trim();
  const baseUrl = normCoolifyUrl(c.baseUrl || c.base_url || row.base_url);
  if (!name) throw Object.assign(new Error("Connection name is required."), { status: 400 });
  if (!baseUrl) throw Object.assign(new Error("Coolify URL is required."), { status: 400 });
  const t = String(c.token || "").trim();
  const enc = t ? await secret.encrypt(t) : row.token_enc;
  if (!enc) throw Object.assign(new Error("Coolify API token is required."), { status: 400 });
  const r = await q(
    `UPDATE ${S}.coolify_connections SET name = $2, base_url = $3, token_enc = $4 WHERE id = $1 RETURNING *`,
    [id, name, baseUrl, enc],
  );
  return r[0];
}

async function deleteCoolifyConnection(id) {
  const n = await q(`SELECT count(*)::int AS n FROM ${S}.app_targets WHERE coolify_connection_id = $1`, [id]);
  if (n[0].n > 0) {
    throw Object.assign(new Error(
      "仍有 " + n[0].n + " 個傳送位置使用此連線,無法刪除。 · " +
      "This connection is still used by " + n[0].n + " delivery target(s) — remove or reassign them first."), { status: 409 });
  }
  const row = await getCoolifyConnection(id);
  if (!row) throw Object.assign(new Error("No such Coolify connection."), { status: 404 });
  if (row.from_env) {
    throw Object.assign(new Error(
      "無法刪除由環境變數提供的連線。 · The environment-provided connection cannot be deleted."), { status: 400 });
  }
  await q(`DELETE FROM ${S}.coolify_connections WHERE id = $1`, [id]);
}

// ---- Supabase connections ---------------------------------------------------

function supabaseConnectionPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    endpointUrl: row.endpoint_url,
    hasToken: !!(row.token_enc && String(row.token_enc).length),
    sortOrder: row.sort_order,
    targetCount: row.target_count != null ? row.target_count : undefined,
  };
}

async function readSupabaseToken(row) {
  if (!row || !row.token_enc) return "";
  return secret.decrypt(row.token_enc);
}

async function supabaseConnectionView(row) {
  const pub = supabaseConnectionPublic(row);
  if (!pub) return null;
  let plain = "";
  try { plain = await readSupabaseToken(row); } catch (e) { plain = ""; }
  return withTokenPreview(pub, plain);
}

const listSupabaseConnections = async () => q(
  `SELECT c.*, (SELECT count(*)::int FROM ${S}.app_targets t WHERE t.supabase_connection_id = c.id) AS target_count
   FROM ${S}.supabase_connections c ORDER BY c.sort_order, c.id`);

const getSupabaseConnection = async (id) =>
  (await q(`SELECT * FROM ${S}.supabase_connections WHERE id = $1`, [id]))[0] || null;

async function createSupabaseConnection(c) {
  const supabase = require("./supabase");
  const name = String(c.name || "").trim();
  const resolved = supabase.resolveEndpoint(c.endpointUrl || c.endpoint_url || c.baseUrl || "");
  const endpoint = resolved.endpoint;
  if (!name) throw Object.assign(new Error("Connection name is required."), { status: 400 });
  const t = String(c.token || "").trim();
  if (!t) throw Object.assign(new Error("Supabase API token is required."), { status: 400 });
  const r = await q(
    `INSERT INTO ${S}.supabase_connections (name, endpoint_url, token_enc, sort_order)
     VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ${S}.supabase_connections)) RETURNING *`,
    [name, endpoint, await secret.encrypt(t)],
  );
  return r[0];
}

async function updateSupabaseConnection(id, c) {
  const supabase = require("./supabase");
  const row = await getSupabaseConnection(id);
  if (!row) throw Object.assign(new Error("No such Supabase connection."), { status: 404 });
  const name = String(c.name || row.name).trim();
  const resolved = supabase.resolveEndpoint(c.endpointUrl || c.endpoint_url || row.endpoint_url);
  const endpoint = resolved.endpoint;
  if (!name) throw Object.assign(new Error("Connection name is required."), { status: 400 });
  const t = String(c.token || "").trim();
  const enc = t ? await secret.encrypt(t) : row.token_enc;
  if (!enc) throw Object.assign(new Error("Supabase API token is required."), { status: 400 });
  const r = await q(
    `UPDATE ${S}.supabase_connections SET name = $2, endpoint_url = $3, token_enc = $4 WHERE id = $1 RETURNING *`,
    [id, name, endpoint, enc],
  );
  return r[0];
}

async function deleteSupabaseConnection(id) {
  const n = await q(`SELECT count(*)::int AS n FROM ${S}.app_targets WHERE supabase_connection_id = $1`, [id]);
  if (n[0].n > 0) {
    throw Object.assign(new Error(
      "仍有 " + n[0].n + " 個傳送位置使用此連線,無法刪除。 · " +
      "This connection is still used by " + n[0].n + " delivery target(s) — remove or reassign them first."), { status: 409 });
  }
  const row = await getSupabaseConnection(id);
  if (!row) throw Object.assign(new Error("No such Supabase connection."), { status: 404 });
  await q(`DELETE FROM ${S}.supabase_connections WHERE id = $1`, [id]);
}

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

// Same rule for a registration we only watch from a distance.
async function claimUntrackedAlert(objectId, keyId, threshold) {
  const r = await q(`INSERT INTO ${S}.untracked_alerts_sent (object_id, key_id, threshold) VALUES ($1,$2,$3)
                     ON CONFLICT DO NOTHING RETURNING 1`, [String(objectId), String(keyId), threshold]);
  return !!r[0];
}
const releaseUntrackedAlert = (objectId, keyId, threshold) =>
  q(`DELETE FROM ${S}.untracked_alerts_sent WHERE object_id = $1 AND key_id = $2 AND threshold = $3`,
    [String(objectId), String(keyId), threshold]);
// A credential that has been replaced leaves its rows behind for good; prune.
const pruneUntrackedAlerts = (days) =>
  q(`DELETE FROM ${S}.untracked_alerts_sent WHERE sent_at < NOW() - ($1 || ' days')::interval`, [String(days)]);

const audit = (email, action, target, detail) =>
  q(`INSERT INTO ${S}.audit_log (email, action, target, detail) VALUES ($1,$2,$3,$4)`,
    [String(email || ""), String(action), String(target || ""), JSON.stringify(detail || {})])
    .catch((e) => console.warn("audit failed:", e.message));

const listAudit = (limit) =>
  q(`SELECT * FROM ${S}.audit_log ORDER BY at DESC LIMIT ${clampInt(limit, 1, 500, 100)}`);

module.exports = {
  SCHEMA, init, LIFETIME_MONTHS_ERROR, assertLifetimeMonths, normCoolifyUrl, migrateCoolifyConnections,
  listApps, getApp, getAppByObjectId, createApp, updateApp, deleteApp, touchRotated,
  isSupabaseAzureAuthTarget, supabaseAuthVarName, targetFields,
  listTargets, getTarget, createTarget, updateTarget, deleteTarget,
  listCoolifyConnections, getCoolifyConnection, createCoolifyConnection, updateCoolifyConnection, deleteCoolifyConnection,
  connectionPublic, tokenMask, withTokenPreview, readCoolifyToken, coolifyConnectionView,
  listSupabaseConnections, getSupabaseConnection, createSupabaseConnection, updateSupabaseConnection, deleteSupabaseConnection,
  supabaseConnectionPublic, readSupabaseToken, supabaseConnectionView,
  listCredentials, syncCredentials, setCurrent, currentCredential, markCreatedHere,
  addCredentialRow, deleteCredentialRow,
  saveSecretValue, readSecretValue, hasSecretValue, deleteSecretValue,
  startRun, step, finishRun, listRuns, getRun, pruneRuns, releaseStaleRuns,
  saveSnapshot, readSnapshot,
  claimAlert, clearAlerts, claimUntrackedAlert, releaseUntrackedAlert, pruneUntrackedAlerts, audit, listAudit,
};
