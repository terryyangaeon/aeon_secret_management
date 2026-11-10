// Coolify REST API client — reads applications and their environment
// variables, writes the rotated secret into one, and restarts the app.
//
//   base   https://<coolify-host>/api/v1
//   auth   Authorization: Bearer <api token>
//
// The token is kept encrypted in the settings table, or supplied as
// COOLIFY_API_TOKEN / COOLIFY_URL.
//
// Create the token in Coolify → Keys & Tokens → API Tokens. It needs
// read:sensitive (so the current value can be read back and snapshotted before
// a rotation), write (to change the variable) and deploy (to restart). A plain
// `read` token hides values, and rotation then refuses rather than overwrite
// something it could not record.
//
// Unlike Zeabur, every endpoint used here is documented and takes a single
// key — there is no bulk-replace hazard and nothing is guessed at runtime.
const appdb = require("./appdb");
const secret = require("./secret");

const TIMEOUT_MS = 25000;
const SETTING_KEY = "coolify";
const RETRY_AFTER_MAX_MS = 10000;

function cErr(msg, status, code) {
  return Object.assign(new Error(msg), { status: status || 502, code: code || "coolify_unavailable" });
}

// ---- Connection settings ----------------------------------------------------

let cache = null;
async function getConfig() {
  if (process.env.COOLIFY_URL && process.env.COOLIFY_API_TOKEN) {
    return { baseUrl: normUrl(process.env.COOLIFY_URL), token: process.env.COOLIFY_API_TOKEN, fromEnv: true };
  }
  if (cache) return cache;
  const v = await appdb.getSetting(SETTING_KEY, null);
  if (!v || !v.baseUrl || !v.enc) return { baseUrl: (v && v.baseUrl) || "", token: "", fromEnv: false };
  cache = { baseUrl: v.baseUrl, token: await secret.decrypt(v.enc), fromEnv: false };
  return cache;
}

async function setConfig(baseUrl, token) {
  const url = normUrl(baseUrl);
  if (!url) throw cErr("Coolify URL is required, e.g. https://coolify-kvm.aeondelightasia.online", 400, "bad_url");
  const t = String(token || "").trim();
  if (!t) throw cErr("Coolify API token is required.", 400, "bad_token");
  await appdb.setSetting(SETTING_KEY, { baseUrl: url, enc: await secret.encrypt(t) });
  cache = { baseUrl: url, token: t, fromEnv: false };
}

async function clearConfig() {
  await appdb.setSetting(SETTING_KEY, {});
  cache = null;
}

// "coolify-kvm.aeondelightasia.online" → "https://coolify-kvm.aeondelightasia.online"
function normUrl(u) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/api\/v1$/i, "");
}

async function configured() {
  const c = await getConfig();
  return !!(c.baseUrl && c.token);
}

// ---- HTTP -------------------------------------------------------------------

// path is relative to /api/v1 (e.g. "/applications").
async function call(path, opts) {
  const o = opts || {};
  const c = await getConfig();
  if (!c.baseUrl || !c.token) {
    throw cErr("尚未設定 Coolify 連線。 · Coolify is not connected — add the server URL and an API token in Configuration.", 503, "coolify_not_configured");
  }
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

  // 200 req/min per token. One retry on 429 when it asks for a short wait.
  if (r.status === 429 && !o._retried) {
    const wait = Math.min(RETRY_AFTER_MAX_MS, (parseInt(r.headers.get("retry-after") || "2", 10) || 2) * 1000);
    await new Promise((res) => setTimeout(res, wait));
    return call(path, Object.assign({}, o, { _retried: true }));
  }

  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 400) throw cErr("Coolify rejected the API token (HTTP " + r.status + ") — it may be wrong, expired or revoked.", 403, "coolify_unauthorized");
  if (r.status === 403) throw cErr("The Coolify token is not allowed to do that. It needs read:sensitive, write and deploy permissions.", 403, "coolify_forbidden");
  if (r.status === 404) throw cErr("Coolify: not found — " + path, 404, "coolify_not_found");
  if (!r.ok) throw cErr("Coolify: " + (j.message || "HTTP " + r.status), r.status >= 500 ? 502 : r.status, "coolify_error");
  return j;
}

// ---- Applications -----------------------------------------------------------

async function listApplications() {
  const rows = await call("/applications");
  return (Array.isArray(rows) ? rows : []).map((a) => ({
    uuid: a.uuid,
    name: a.name || "",
    fqdn: firstUrl(a.fqdn),
    status: a.status || "",
  })).sort((x, y) => x.name.localeCompare(y.name));
}

// fqdn can be "https://a.example,https://www.a.example" — take the first.
const firstUrl = (f) => String(f || "").split(",")[0].trim();

async function getApplication(uuid) {
  const a = await call("/applications/" + encodeURIComponent(uuid));
  return a && { uuid: a.uuid, name: a.name || "", fqdn: firstUrl(a.fqdn), status: a.status || "" };
}

// ---- Environment variables --------------------------------------------------

// → { vars: {KEY: value|null}, values: bool }
// values is false when the token can't see secret values (no read:sensitive),
// in which case a rotation can't snapshot what it is about to overwrite.
//
// Coolify returns the SAME key twice when an application also has preview
// (pull-request) deployments: one row with is_preview false, one with true, and
// their values genuinely differ. Only the production set is ours — snapshotting
// a preview value and rolling it back would write the wrong secret into
// production. Pass { preview: true } to look at the other set deliberately.
async function listVariables(appUuid, opts) {
  const wantPreview = !!(opts && opts.preview);
  const rows = await call("/applications/" + encodeURIComponent(appUuid) + "/envs");
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

async function getVariable(appUuid, name) {
  const r = await listVariables(appUuid);
  if (!(name in r.vars)) return { exists: false, value: null, readable: r.values };
  return { exists: true, value: r.vars[name], readable: r.vars[name] !== null };
}

// Writes one key and leaves every other variable alone.
// PATCH updates; the docs don't say whether it creates a missing key, so a
// 404 falls back to POST (and a POST onto an existing key falls back to PATCH).
async function setVariable(appUuid, name, value) {
  const body = { key: String(name), value: String(value), is_preview: false };
  const base = "/applications/" + encodeURIComponent(appUuid) + "/envs";
  try {
    await call(base, { method: "PATCH", body });
    return { mode: "patch", key: name };
  } catch (e) {
    if (e.code !== "coolify_not_found") throw e;
    await call(base, { method: "POST", body });
    return { mode: "create", key: name };
  }
}

// ---- Restart ----------------------------------------------------------------

// Coolify's docs don't say whether a changed variable reaches a running
// container on its own, so a rotation always restarts and then health-checks.
async function restartApplication(appUuid) {
  const j = await call("/applications/" + encodeURIComponent(appUuid) + "/restart", { method: "POST" });
  return (j && j.deployment_uuid) || "restart";
}

// ---- Connection test --------------------------------------------------------

async function test() {
  const c = await getConfig();
  const out = { ok: false, baseUrl: c.baseUrl, fromEnv: !!c.fromEnv, team: "", applications: 0, canReadValues: null, note: "" };

  const team = await call("/teams/current").catch(() => null);
  out.team = (team && (team.name || team.id)) ? String(team.name || team.id) : "";

  const apps = await listApplications();
  out.applications = apps.length;
  out.ok = true;

  // Can this token actually see values? Without that, rollback has nothing to
  // restore, so say so here rather than at rotation time.
  const probe = apps[0];
  if (probe) {
    try {
      const v = await listVariables(probe.uuid);
      out.canReadValues = v.values;
      if (!v.values) out.note = "The token can list variables but not read their values — add the read:sensitive permission, or a rotation won't be able to snapshot the old value.";
    } catch (e) {
      out.canReadValues = false;
      out.note = e.message;
    }
  } else {
    out.note = "No applications are visible to this token yet.";
  }
  return out;
}

module.exports = {
  getConfig, setConfig, clearConfig, configured, call, test,
  listApplications, getApplication,
  listVariables, getVariable, setVariable, restartApplication,
};
