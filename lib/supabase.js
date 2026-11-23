// Supabase Management API — lists a project's secrets and writes one.
//
//   GET/POST  https://api.supabase.com/v1/projects/<ref>/secrets
//   auth      Authorization: Bearer <personal access token>
//
// A connection stores a name, the project endpoint the user typed, and the
// token encrypted in supabase_connections (lib/regdb.js). The endpoint is
// either the project URL (https://<ref>.supabase.co) or the management URL
// (https://api.supabase.com/v1/projects/<ref>).
//
// List responses name every secret. The value field is a digest, not the
// current secret, so it is never treated as something a rotation can restore
// and it is never sent to the browser. Updating one name is a POST of
// [{ name, value }]; other secrets on the project are left alone.
const regdb = require("./regdb");
const secret = require("./secret");

const TIMEOUT_MS = 25000;
const RETRY_AFTER_MAX_MS = 10000;
const MANAGEMENT_ORIGIN = "https://api.supabase.com";

let testResolver = null;

function sErr(msg, status, code) {
  return Object.assign(new Error(msg), { status: status || 502, code: code || "supabase_unavailable" });
}

function normEndpoint(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let url;
  try { url = new URL(s); } catch (e) { return s.replace(/\/+$/, ""); }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

// Turn the stored endpoint into the secrets collection URL. Throws 400 when
// the URL does not identify one project.
function resolveEndpoint(endpoint) {
  const raw = normEndpoint(endpoint);
  if (!raw) throw sErr("Supabase endpoint URL is required, e.g. https://<project-ref>.supabase.co", 400, "bad_url");
  let url;
  try { url = new URL(raw); } catch (e) {
    throw sErr("Supabase endpoint URL is not a valid URL.", 400, "bad_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw sErr("Supabase endpoint URL must start with https://.", 400, "bad_url");
  }
  const host = url.hostname.toLowerCase();
  const projectHost = host.match(/^(?:db\.)?([a-z0-9]{8,40})\.supabase\.co$/);
  if (projectHost && projectHost[1] !== "api") {
    const ref = projectHost[1];
    return { endpoint: raw, ref, secretsUrl: MANAGEMENT_ORIGIN + "/v1/projects/" + ref + "/secrets" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  const managed = path.match(/\/v1\/projects\/([a-z0-9]{8,40})(?:\/secrets)?$/i);
  if (managed) {
    const ref = managed[1].toLowerCase();
    return { endpoint: raw, ref, secretsUrl: url.origin + "/v1/projects/" + ref + "/secrets" };
  }
  throw sErr(
    "Supabase endpoint must identify one project. Use the project URL (https://<project-ref>.supabase.co) or https://api.supabase.com/v1/projects/<project-ref>.",
    400, "bad_url");
}

function setTestConnectionResolver(fn) {
  testResolver = fn;
}

async function configFromRow(row) {
  if (!row || !row.endpoint_url || !row.token_enc) return null;
  const resolved = resolveEndpoint(row.endpoint_url);
  return {
    id: row.id,
    endpoint: resolved.endpoint,
    ref: resolved.ref,
    secretsUrl: resolved.secretsUrl,
    token: await secret.decrypt(row.token_enc),
    name: row.name,
  };
}

async function getConnectionConfig(connectionId) {
  if (testResolver) return testResolver(connectionId);
  if (connectionId == null || connectionId === "") {
    throw sErr("尚未設定 Supabase 連線。 · Supabase is not connected — add a connection in Configuration.", 503, "supabase_not_configured");
  }
  const row = await regdb.getSupabaseConnection(connectionId);
  const c = row ? await configFromRow(row) : null;
  if (!c || !c.secretsUrl || !c.token) {
    throw sErr("Supabase connection is incomplete or missing — check the endpoint URL and token in Configuration.", 503, "supabase_not_configured");
  }
  return c;
}

async function configured() {
  if (testResolver) return true;
  const rows = await regdb.listSupabaseConnections();
  for (const row of rows) {
    try {
      const c = await configFromRow(row);
      if (c && c.token) return true;
    } catch (e) { /* a saved row with a bad URL is not usable */ }
  }
  return false;
}

async function connectionReady(connectionId) {
  try {
    const c = await getConnectionConfig(connectionId);
    return !!(c && c.secretsUrl && c.token);
  } catch (e) {
    return false;
  }
}

async function listConnectionsPublic() {
  const rows = await regdb.listSupabaseConnections();
  return rows.map(regdb.supabaseConnectionPublic);
}

async function call(connectionId, opts) {
  const o = opts || {};
  const c = await getConnectionConfig(connectionId);
  const headers = { Authorization: "Bearer " + c.token, Accept: "application/json" };
  let body;
  if (o.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.body); }

  let r;
  try {
    r = await fetch(c.secretsUrl, {
      method: o.method || "GET", headers, body, signal: AbortSignal.timeout(o.timeout || TIMEOUT_MS),
    });
  } catch (e) {
    throw sErr("Could not reach Supabase for project " + c.ref + ": " + (e.name === "TimeoutError" ? "timed out" : e.message));
  }

  if (r.status === 429 && !o._retried) {
    const wait = Math.min(RETRY_AFTER_MAX_MS, (parseInt(r.headers.get("retry-after") || "2", 10) || 2) * 1000);
    await new Promise((res) => setTimeout(res, wait));
    return call(connectionId, Object.assign({}, o, { _retried: true }));
  }

  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw sErr("Supabase rejected the API token (HTTP 401) — it may be wrong, expired or revoked.", 403, "supabase_unauthorized");
  if (r.status === 403) throw sErr("The Supabase token is not allowed to do that. It needs permission to read and write project secrets.", 403, "supabase_forbidden");
  if (r.status === 404) throw sErr("Supabase project was not found — check the endpoint URL.", 404, "supabase_not_found");
  if (!r.ok) throw sErr("Supabase: " + (j.message || j.error || "HTTP " + r.status), r.status >= 500 ? 502 : r.status, "supabase_error");
  return j;
}

// Names only. Digests from the API are discarded so they cannot be written
// back as if they were the secret.
async function listSecrets(connectionId) {
  const rows = await call(connectionId, { method: "GET" });
  const names = [];
  for (const e of (Array.isArray(rows) ? rows : [])) {
    if (e && e.name) names.push(String(e.name));
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, readable: false };
}

async function getVariable(connectionId, name) {
  const r = await listSecrets(connectionId);
  return { exists: r.names.indexOf(String(name)) >= 0, value: null, readable: false };
}

async function setVariable(connectionId, name, value) {
  const key = String(name || "").trim();
  if (!key) throw sErr("Variable name is required.", 400, "bad_name");
  if (key.startsWith("SUPABASE_")) {
    throw sErr("Supabase refuses secret names that start with SUPABASE_.", 400, "bad_name");
  }
  await call(connectionId, { method: "POST", body: [{ name: key, value: String(value) }] });
  return { mode: "upsert", key };
}

async function test(connectionId) {
  const c = await getConnectionConfig(connectionId);
  const out = {
    ok: false, connectionId: c.id || null, endpoint: c.endpoint, projectRef: c.ref,
    name: c.name || "", secrets: 0, canReadValues: false, note: "",
  };
  const listed = await listSecrets(connectionId);
  out.secrets = listed.names.length;
  out.ok = true;
  out.note = "Connected. Supabase lists secret names only — the current value is a digest, not the secret — so a rotation snapshots the copy stored by this app.";
  return out;
}

module.exports = {
  normEndpoint, resolveEndpoint, setTestConnectionResolver,
  getConnectionConfig, configured, connectionReady, listConnectionsPublic,
  listSecrets, getVariable, setVariable, test,
};
