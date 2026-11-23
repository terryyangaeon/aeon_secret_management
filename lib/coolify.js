// Coolify REST API client — reads applications and their environment
// variables, writes the rotated secret into one, and restarts the app.
//
//   base   https://<coolify-host>/api/v1
//   auth   Authorization: Bearer <api token>
//
// Each delivery target points at a row in coolify_connections (lib/regdb.js).
// Tokens are encrypted at rest; COOLIFY_URL / COOLIFY_API_TOKEN can supply one
// read-only "environment" connection for legacy installs.
const regdb = require("./regdb");
const secret = require("./secret");

const TIMEOUT_MS = 25000;
const SETTING_KEY = "coolify";
const RETRY_AFTER_MAX_MS = 10000;

let testResolver = null;

function cErr(msg, status, code) {
  return Object.assign(new Error(msg), { status: status || 502, code: code || "coolify_unavailable" });
}

function normUrl(u) {
  return regdb.normCoolifyUrl(u);
}

function setTestConnectionResolver(fn) {
  testResolver = fn;
}

async function configFromRow(row) {
  if (!row) return null;
  if (row.from_env) {
    const url = process.env.COOLIFY_URL || "";
    const token = process.env.COOLIFY_API_TOKEN || "";
    if (!url || !token) return null;
    return { id: row.id, baseUrl: normUrl(url), token, fromEnv: true, name: row.name };
  }
  if (!row.base_url || !row.token_enc) return null;
  return {
    id: row.id,
    baseUrl: normUrl(row.base_url),
    token: await secret.decrypt(row.token_enc),
    fromEnv: false,
    name: row.name,
  };
}

// connectionId is required for production paths. Omitting it uses COOLIFY_* env
// only (unit tests and legacy callers).
async function getConnectionConfig(connectionId) {
  if (testResolver) return testResolver(connectionId);
  if (connectionId != null && connectionId !== "") {
    const row = await regdb.getCoolifyConnection(connectionId);
    const c = await configFromRow(row);
    if (!c || !c.baseUrl || !c.token) {
      throw cErr("Coolify connection is incomplete or missing — check URL and token in Configuration.", 503, "coolify_not_configured");
    }
    return c;
  }
  if (process.env.COOLIFY_URL && process.env.COOLIFY_API_TOKEN) {
    return { baseUrl: normUrl(process.env.COOLIFY_URL), token: process.env.COOLIFY_API_TOKEN, fromEnv: true, id: null };
  }
  throw cErr("尚未設定 Coolify 連線。 · Coolify is not connected — add a connection in Configuration.", 503, "coolify_not_configured");
}

async function configured() {
  if (testResolver) return true;
  if (process.env.COOLIFY_URL && process.env.COOLIFY_API_TOKEN) return true;
  const rows = await regdb.listCoolifyConnections();
  for (const row of rows) {
    const c = await configFromRow(row);
    if (c && c.baseUrl && c.token) return true;
  }
  return false;
}

async function connectionReady(connectionId) {
  try {
    const c = await getConnectionConfig(connectionId);
    return !!(c && c.baseUrl && c.token);
  } catch (e) {
    return false;
  }
}

async function listConnectionsPublic() {
  const rows = await regdb.listCoolifyConnections();
  return rows.map(regdb.connectionPublic);
}

// path is relative to /api/v1 (e.g. "/applications").
async function call(connectionId, path, opts) {
  const o = opts || {};
  const c = await getConnectionConfig(connectionId);
  const headers = { Authorization: "Bearer " + c.token, Accept: "application/json" };
  let body;
  if (o.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.body); }

  let r;
  try {
    r = await fetch(c.baseUrl + "/api/v1" + path, {
      method: o.method || "GET", headers, body, signal: AbortSignal.timeout(o.timeout || TIMEOUT_MS),
    });
  } catch (e) {
    throw cErr("Could not reach Coolify at " + c.baseUrl + ": " + (e.name === "TimeoutError" ? "timed out" : e.message));
  }

  if (r.status === 429 && !o._retried) {
    const wait = Math.min(RETRY_AFTER_MAX_MS, (parseInt(r.headers.get("retry-after") || "2", 10) || 2) * 1000);
    await new Promise((res) => setTimeout(res, wait));
    return call(connectionId, path, Object.assign({}, o, { _retried: true }));
  }

  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 400) throw cErr("Coolify rejected the API token (HTTP " + r.status + ") — it may be wrong, expired or revoked.", 403, "coolify_unauthorized");
  if (r.status === 403) throw cErr("The Coolify token is not allowed to do that. It needs read:sensitive, write and deploy permissions.", 403, "coolify_forbidden");
  if (r.status === 404) throw cErr("Coolify: not found — " + path, 404, "coolify_not_found");
  if (!r.ok) throw cErr("Coolify: " + (j.message || "HTTP " + r.status), r.status >= 500 ? 502 : r.status, "coolify_error");
  return j;
}

async function listApplications(connectionId) {
  const rows = await call(connectionId, "/applications");
  return (Array.isArray(rows) ? rows : []).map((a) => ({
    uuid: a.uuid,
    name: a.name || "",
    fqdn: firstUrl(a.fqdn),
    status: a.status || "",
  })).sort((x, y) => x.name.localeCompare(y.name));
}

const firstUrl = (f) => String(f || "").split(",")[0].trim();

async function getApplication(connectionId, uuid) {
  const a = await call(connectionId, "/applications/" + encodeURIComponent(uuid));
  return a && { uuid: a.uuid, name: a.name || "", fqdn: firstUrl(a.fqdn), status: a.status || "" };
}

async function listVariables(connectionId, appUuid, opts) {
  const wantPreview = !!(opts && opts.preview);
  const rows = await call(connectionId, "/applications/" + encodeURIComponent(appUuid) + "/envs");
  const vars = {};
  let readable = 0, total = 0;
  for (const e of (Array.isArray(rows) ? rows : [])) {
    if (!e || !e.key) continue;
    if (!!e.is_preview !== wantPreview) continue;
    total++;
    const v = e.value !== undefined && e.value !== null ? e.value
      : (e.real_value !== undefined && e.real_value !== null ? e.real_value : null);
    vars[e.key] = v;
    if (v !== null) readable++;
  }
  return { vars, values: total === 0 ? true : readable > 0 };
}

async function getVariable(connectionId, appUuid, name) {
  const r = await listVariables(connectionId, appUuid);
  if (!(name in r.vars)) return { exists: false, value: null, readable: r.values };
  return { exists: true, value: r.vars[name], readable: r.vars[name] !== null };
}

async function setVariable(connectionId, appUuid, name, value) {
  const body = { key: String(name), value: String(value), is_preview: false };
  const base = "/applications/" + encodeURIComponent(appUuid) + "/envs";
  try {
    await call(connectionId, base, { method: "PATCH", body });
    return { mode: "patch", key: name };
  } catch (e) {
    if (e.code !== "coolify_not_found") throw e;
    await call(connectionId, base, { method: "POST", body });
    return { mode: "create", key: name };
  }
}

async function restartApplication(connectionId, appUuid) {
  const j = await call(connectionId, "/applications/" + encodeURIComponent(appUuid) + "/restart", { method: "POST" });
  return (j && j.deployment_uuid) || "restart";
}

async function test(connectionId) {
  const c = await getConnectionConfig(connectionId);
  const out = {
    ok: false, connectionId: c.id || null, baseUrl: c.baseUrl, fromEnv: !!c.fromEnv,
    name: c.name || "", team: "", applications: 0, canReadValues: null, note: "",
  };

  const team = await call(connectionId, "/teams/current").catch(() => null);
  out.team = (team && (team.name || team.id)) ? String(team.name || team.id) : "";

  const apps = await listApplications(connectionId);
  out.applications = apps.length;
  out.ok = true;

  const probe = apps[0];
  if (probe) {
    try {
      const v = await listVariables(connectionId, probe.uuid);
      out.canReadValues = v.values;
      if (!v.values) {
        out.note = "The token can list variables but not read their values — add the read:sensitive permission, or a rotation won't be able to snapshot the old value.";
      }
    } catch (e) {
      out.canReadValues = false;
      out.note = e.message;
    }
  } else {
    out.note = "No applications are visible to this token yet.";
  }
  return out;
}

// ---- Deprecated single-connection helpers (migration only) ------------------

const appdb = require("./appdb");

async function getConfig() {
  const rows = await regdb.listCoolifyConnections();
  if (rows.length === 1) {
    const c = await configFromRow(rows[0]);
    if (c) return { baseUrl: c.baseUrl, fromEnv: !!c.fromEnv, configured: !!(c.baseUrl && c.token) };
  }
  if (process.env.COOLIFY_URL && process.env.COOLIFY_API_TOKEN) {
    return { baseUrl: normUrl(process.env.COOLIFY_URL), fromEnv: true, configured: true };
  }
  return { baseUrl: "", fromEnv: false, configured: await configured() };
}

async function setConfig(baseUrl, token) {
  const url = normUrl(baseUrl);
  if (!url) throw cErr("Coolify URL is required.", 400, "bad_url");
  const t = String(token || "").trim();
  if (!t) throw cErr("Coolify API token is required.", 400, "bad_token");
  const rows = await regdb.listCoolifyConnections();
  if (rows.length === 0) {
    await regdb.createCoolifyConnection({ name: "Primary", baseUrl: url, token: t });
    return;
  }
  const primary = rows[0];
  if (primary.from_env) {
    throw cErr("This connection is supplied by environment variables.", 400, "from_env");
  }
  await regdb.updateCoolifyConnection(primary.id, { name: primary.name, baseUrl: url, token: t });
  // Retire the legacy settings row so we do not maintain two sources of truth.
  await appdb.setSetting(SETTING_KEY, {}).catch(() => {});
}

async function clearConfig() {
  await appdb.setSetting(SETTING_KEY, {});
}

module.exports = {
  normUrl, setTestConnectionResolver,
  getConnectionConfig, configured, connectionReady, listConnectionsPublic,
  listApplications, getApplication, listVariables, getVariable, setVariable, restartApplication,
  test, call,
  getConfig, setConfig, clearConfig,
};