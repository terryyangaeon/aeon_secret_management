// Microsoft Graph client (app-only / client credentials).
//
// Uses the same app registration as sign-in: SSO_TENANT_ID, SSO_CLIENT_ID,
// SSO_CLIENT_SECRET. lib/sso.js keeps its own copy of the token dance for the
// directory lookup so that file stays identical to the shared OneView
// reference; everything else in this app (the registry, the mailer, rotation)
// goes through graphFetch() here.
//
// Application permissions needed, with admin consent:
//   User.Read.All                  — directory check in Account Management (lib/sso.js)
//   Application.ReadWrite.OwnedBy  — list / rotate secrets on owned app registrations
//   Mail.Send                      — expiry and rotation emails
const TENANT = process.env.SSO_TENANT_ID || "";
const CLIENT_ID = process.env.SSO_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || "";
const BASE = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 20000;

const enabled = () => !!(TENANT && CLIENT_ID && CLIENT_SECRET);

function graphError(msg, status, code) {
  return Object.assign(new Error(msg), { status: status || 502, code: code || "graph_unavailable" });
}

let tok = null, tokExp = 0;
async function token() {
  if (!enabled()) throw graphError("Microsoft Graph is not configured on this server (SSO_TENANT_ID / SSO_CLIENT_ID / SSO_CLIENT_SECRET).", 503, "graph_not_configured");
  if (tok && Date.now() < tokExp - 60000) return tok;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(TIMEOUT_MS),
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const d = String(j.error_description || j.error || "HTTP " + r.status).split("\r\n")[0];
    // AADSTS7000215 = wrong/expired secret. Say so plainly: this app's own
    // secret expiring is exactly the failure it exists to prevent elsewhere.
    throw graphError("Could not sign in to Microsoft Graph: " + d +
      (/7000215/.test(d) ? " — 此應用程式自己的 SSO_CLIENT_SECRET 已失效或過期。 · This app's own SSO_CLIENT_SECRET is wrong or expired." : ""),
      502, "graph_auth_failed");
  }
  tok = j.access_token; tokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return tok;
}

// path is relative to /v1.0 (e.g. "/applications?$top=5").
// Returns the parsed body, or null for 204 No Content.
async function graphFetch(path, opts) {
  const o = opts || {};
  const headers = { Authorization: "Bearer " + (await token()) };
  let body;
  if (o.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.body); }
  const r = await fetch(BASE + path, { method: o.method || "GET", headers, body, signal: AbortSignal.timeout(o.timeout || TIMEOUT_MS) });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw graphError(permissionHint(path, (j.error && j.error.message) || ""), 403, "graph_forbidden");
  if (!r.ok) throw graphError("Microsoft Graph: " + ((j.error && j.error.message) || "HTTP " + r.status), r.status >= 500 ? 502 : r.status, "graph_error");
  return j;
}

// Follows @odata.nextLink and concatenates .value.
async function graphList(path) {
  let out = [], url = path;
  for (let i = 0; i < 50 && url; i++) {
    const j = await graphFetch(url);
    out = out.concat(j.value || []);
    url = j["@odata.nextLink"] ? j["@odata.nextLink"].replace(BASE, "") : "";
  }
  return out;
}

function permissionHint(path, detail) {
  const where = "Entra admin center → App registrations → this app → API permissions";
  if (/^\/applications/.test(path)) {
    return "未獲授權讀取或修改應用程式註冊。 · Not allowed to read/modify app registrations. In " + where +
      ", add Microsoft Graph › Application › Application.ReadWrite.OwnedBy and click “Grant admin consent”. " +
      "Then, on each app registration you want managed, add this app as an Owner." + (detail ? " (" + detail + ")" : "");
  }
  if (/sendMail/.test(path)) {
    return "未獲授權寄出郵件。 · Not allowed to send mail. In " + where +
      ", add Microsoft Graph › Application › Mail.Send and click “Grant admin consent”. " +
      "Also check the sender mailbox exists and any application access policy includes this app." + (detail ? " (" + detail + ")" : "");
  }
  return "Microsoft Graph refused the request (403). " + where + (detail ? " (" + detail + ")" : "");
}

module.exports = { enabled, token, graphFetch, graphList, graphError, BASE };
