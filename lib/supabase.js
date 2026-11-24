// Supabase Management API.
//
//   GET/POST  https://api.supabase.com/v1/projects/<ref>/secrets
//   GET/PATCH https://api.supabase.com/v1/projects/<ref>/config/auth
//   auth      Authorization: Bearer <personal access token>
//
// A connection stores a name, the project endpoint the user typed, and the
// token encrypted in supabase_connections (lib/regdb.js). The endpoint is the
// project URL (https://<ref>.supabase.co) or the management URL
// (https://api.supabase.com/v1/projects/<ref>). A /secrets or /config/auth
// suffix is accepted and normalized back to that project.
//
// Project secrets: list responses name every secret. The value field is a
// digest, not the current secret, so it is never treated as something a
// rotation can restore and it is never sent to the browser. Updating one name
// is a POST of [{ name, value }]; other secrets on the project are left alone.
//
// Auth config: an "Auth: Azure secret" delivery target PATCHes
// { external_azure_secret } and does not restart anything. GET may return that
// field in plaintext. When it does, rollback restores that exact value. When
// it is missing, empty, masked, or a digest, this module reports it unreadable
// and the rotation falls back to the copy of the current Entra secret this app
// stored. If that copy is missing too, rollback cannot restore the auth field.
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

// Turn the stored endpoint into the project ref and the two management URLs.
// Throws 400 when the URL does not identify one project. A /secrets or
// /config/auth suffix is stripped; the saved endpoint is the project itself.
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
    const base = MANAGEMENT_ORIGIN + "/v1/projects/" + ref;
    return { endpoint: raw, ref, secretsUrl: base + "/secrets", authUrl: base + "/config/auth" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  const managed = path.match(/\/v1\/projects\/([a-z0-9]{8,40})(?:\/(?:secrets|config\/auth))?$/i);
  if (managed) {
    const ref = managed[1].toLowerCase();
    const base = url.origin + "/v1/projects/" + ref;
    return { endpoint: base, ref, secretsUrl: base + "/secrets", authUrl: base + "/config/auth" };
  }
  throw sErr(
    "Supabase endpoint must identify one project. Use the project URL (https://<project-ref>.supabase.co), https://api.supabase.com/v1/projects/<project-ref>, or that management URL ending in /secrets or /config/auth.",
    400, "bad_url");
}

function endpointUrls(c) {
  if (c && c.secretsUrl && c.authUrl) return { secretsUrl: c.secretsUrl, authUrl: c.authUrl };
  const ref = c && c.ref;
  if (ref) {
    const base = MANAGEMENT_ORIGIN + "/v1/projects/" + ref;
    return { secretsUrl: (c && c.secretsUrl) || base + "/secrets", authUrl: (c && c.authUrl) || base + "/config/auth" };
  }
  if (c && c.secretsUrl) {
    return { secretsUrl: c.secretsUrl, authUrl: String(c.secretsUrl).replace(/\/secrets$/, "/config/auth") };
  }
  return null;
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
    authUrl: resolved.authUrl,
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
  const out = [];
  for (const row of rows) out.push(await regdb.supabaseConnectionView(row));
  return out;
}

// which is "secrets" or "auth". The 403 text names that API, not both.
function permissionError(which, method) {
  const verb = String(method || "GET").toUpperCase();
  if (which === "auth") {
    const action = verb === "GET" ? "read" : "update";
    return "The Supabase token cannot " + action + " the project's auth config (" + verb +
      " /config/auth returned 403). An Auth: Azure secret target needs permission to read and update auth config (external_azure_secret). Project-secret permission is a different grant.";
  }
  const action = verb === "GET" ? "read" : "write";
  return "The Supabase token cannot " + action + " project secrets (" + verb +
    " /secrets returned 403). A Project secret target needs secrets:read and secrets:write. An Auth: Azure secret target does not use /secrets.";
}

async function call(connectionId, which, opts) {
  const o = opts || {};
  const c = await getConnectionConfig(connectionId);
  const urls = endpointUrls(c);
  const url = urls && (which === "auth" ? urls.authUrl : urls.secretsUrl);
  if (!url) throw sErr("Supabase connection is incomplete or missing — check the endpoint URL and token in Configuration.", 503, "supabase_not_configured");
  const method = o.method || "GET";
  const headers = { Authorization: "Bearer " + c.token, Accept: "application/json" };
  let body;
  if (o.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.body); }

  let r;
  try {
    r = await fetch(url, {
      method, headers, body, signal: AbortSignal.timeout(o.timeout || TIMEOUT_MS),
    });
  } catch (e) {
    throw sErr("Could not reach Supabase for project " + (c.ref || "") + ": " + (e.name === "TimeoutError" ? "timed out" : e.message));
  }

  if (r.status === 429 && !o._retried) {
    const wait = Math.min(RETRY_AFTER_MAX_MS, (parseInt(r.headers.get("retry-after") || "2", 10) || 2) * 1000);
    await new Promise((res) => setTimeout(res, wait));
    return call(connectionId, which, Object.assign({}, o, { _retried: true }));
  }

  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw sErr("Supabase rejected the API token (HTTP 401) — it may be wrong, expired or revoked.", 403, "supabase_unauthorized");
  if (r.status === 403) throw sErr(permissionError(which, method), 403, which === "auth" ? "supabase_auth_forbidden" : "supabase_secrets_forbidden");
  if (r.status === 404) throw sErr("Supabase project was not found — check the endpoint URL.", 404, "supabase_not_found");
  if (!r.ok) throw sErr("Supabase: " + (j.message || j.error || "HTTP " + r.status), r.status >= 500 ? 502 : r.status, "supabase_error");
  return j;
}

// A plaintext previous secret. Empty, masked, and digest values are not
// something rollback can write back.
function plainSecret(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  if (/^[*•.]+$/.test(s)) return false;
  if (/^(redacted|\[redacted\]|\[filtered\]|null)$/i.test(s)) return false;
  if (/^[a-f0-9]{64}$/i.test(s)) return false;
  return true;
}

// Names only. Digests from the API are discarded so they cannot be written
// back as if they were the secret.
async function listSecrets(connectionId) {
  const rows = await call(connectionId, "secrets", { method: "GET" });
  const names = [];
  for (const e of (Array.isArray(rows) ? rows : [])) {
    if (e && e.name) names.push(String(e.name));
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, readable: false };
}

async function getVariable(connectionId, name) {
  const key = String(name || "").trim();
  if (/^external_azure_secret$/i.test(key)) {
    const v = await getAzureSecret(connectionId);
    return { exists: v.exists, value: v.value, readable: v.readable };
  }
  const r = await listSecrets(connectionId);
  return { exists: r.names.indexOf(key) >= 0, value: null, readable: false };
}

async function setVariable(connectionId, name, value) {
  const key = String(name || "").trim();
  if (!key) throw sErr("Variable name is required.", 400, "bad_name");
  if (key.startsWith("SUPABASE_")) {
    throw sErr("Supabase refuses secret names that start with SUPABASE_.", 400, "bad_name");
  }
  await call(connectionId, "secrets", { method: "POST", body: [{ name: key, value: String(value) }] });
  return { mode: "upsert", key };
}

// The auth-config field used by QPOMS SSO. value is returned only to the
// rotation snapshot, never to a browser response. The response body of the
// GET is not kept.
async function getAzureSecret(connectionId) {
  const j = await call(connectionId, "auth", { method: "GET" }) || {};
  const readable = plainSecret(j.external_azure_secret);
  return {
    exists: true,
    value: readable ? String(j.external_azure_secret) : null,
    readable,
    azureEnabled: j.external_azure_enabled === true,
  };
}

async function setAzureSecret(connectionId, value) {
  const secretText = String(value == null ? "" : value);
  if (!secretText) throw sErr("A secret value is required.", 400, "bad_value");
  await call(connectionId, "auth", { method: "PATCH", body: { external_azure_secret: secretText } });
  return { mode: "patch", key: "external_azure_secret" };
}

// One probe. A 401/403/404 is a result, not a thrown error, so Test connection
// can report auth config and project secrets separately. Other failures throw.
// The response body is returned to the caller and must not be sent to the browser.
async function probe(connectionId, which) {
  try {
    const body = await call(connectionId, which, { method: "GET" });
    return { ok: true, status: 200, body };
  } catch (e) {
    // call() reports a rejected token as status 403 with this code, so the
    // browser does not see a raw 401. Test connection still tells the two apart.
    if (e.code === "supabase_unauthorized") return { ok: false, status: 401, message: e.message };
    if (e.status === 403 || e.status === 404) return { ok: false, status: e.status, message: e.message };
    throw e;
  }
}

function statusBit(p) {
  if (!p || p.ok) return "";
  if (p.status === 401) return " (the API token was rejected, HTTP 401)";
  if (p.status === 403) return " (HTTP 403 — this token does not have that permission)";
  if (p.status === 404) return " (HTTP 404 — the project was not found)";
  return "";
}

async function test(connectionId) {
  const c = await getConnectionConfig(connectionId);
  const out = {
    ok: false, connectionId: c.id || null, endpoint: c.endpoint, projectRef: c.ref,
    name: c.name || "",
    authReadable: false, azureEnabled: null,
    secretsReadable: false, secrets: 0,
    canReadValues: false, note: "",
  };
  const auth = await probe(connectionId, "auth");
  const secrets = await probe(connectionId, "secrets");
  if (auth.ok) {
    const body = auth.body || {};
    out.authReadable = true;
    out.azureEnabled = body.external_azure_enabled === true;
  }
  if (secrets.ok) {
    const rows = Array.isArray(secrets.body) ? secrets.body : [];
    out.secretsReadable = true;
    out.secrets = rows.filter((e) => e && e.name).length;
  }
  out.ok = out.authReadable || out.secretsReadable;
  const parts = [];
  if (out.authReadable) {
    parts.push(out.azureEnabled
      ? "Auth config is readable and the Azure provider is enabled."
      : "Auth config is readable, but the Azure provider is not enabled.");
  } else {
    parts.push("Auth config is not readable" + statusBit(auth) + ".");
  }
  if (out.secretsReadable) {
    parts.push("Project secrets are readable (" + out.secrets + " names). Supabase returns a digest, not the secret, so a project-secret rotation snapshots the copy stored by this app.");
  } else {
    parts.push("Project secrets are not accessible" + statusBit(secrets) + ". That is optional and only matters for a Project secret target.");
  }
  if (out.authReadable && !out.secretsReadable) {
    parts.push("An Auth: Azure secret target can use this connection. A Project secret target cannot.");
  } else if (!out.authReadable && out.secretsReadable) {
    parts.push("A Project secret target can use this connection. An Auth: Azure secret target cannot.");
  } else if (!out.ok) {
    parts.push("This connection cannot be used until the token can read auth config or project secrets.");
  }
  out.note = parts.join(" ");
  return out;
}

module.exports = {
  normEndpoint, resolveEndpoint, setTestConnectionResolver,
  getConnectionConfig, configured, connectionReady, listConnectionsPublic,
  listSecrets, getVariable, setVariable, getAzureSecret, setAzureSecret, test,
};
