// Microsoft Entra ID single sign-on (OpenID Connect, authorization code + PKCE).
// Only accounts that already exist (and are active) in Account Management can
// sign in this way — roles and business units stay managed there.
//
// Env vars: SSO_TENANT_ID, SSO_CLIENT_ID, SSO_CLIENT_SECRET
//           SSO_REDIRECT_URI (optional, default <this host>/api/auth/sso/callback)
//
// Inside OneView's iframe Microsoft's login page can't be framed, so the login
// page opens a popup; the popup hands a one-time code back to the iframe, which
// redeems it so the session cookie is set in the iframe's own (partitioned) jar.
const crypto = require("crypto");
const appdb = require("./appdb");

const TENANT = process.env.SSO_TENANT_ID || "";
const CLIENT_ID = process.env.SSO_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || "";
const S = '"' + appdb.SCHEMA + '"';
const STATE_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 60 * 1000;
const META_TTL_MS = 60 * 60 * 1000;

const enabled = () => !!(TENANT && CLIENT_ID && CLIENT_SECRET);
const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function init() {
  await appdb.q(`CREATE TABLE IF NOT EXISTS ${S}.sso_tokens (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, data JSONB NOT NULL, expires_at BIGINT NOT NULL)`);
}

// One-time records (login state, popup hand-off codes), consumed on read.
async function put(kind, data, ttl) {
  const id = b64url(crypto.randomBytes(24));
  await appdb.q(`DELETE FROM ${S}.sso_tokens WHERE expires_at < $1`, [Date.now()]);
  await appdb.q(`INSERT INTO ${S}.sso_tokens (id, kind, data, expires_at) VALUES ($1,$2,$3,$4)`,
    [id, kind, JSON.stringify(data), Date.now() + ttl]);
  return id;
}
async function take(kind, id) {
  if (!id) return null;
  const r = await appdb.q(`DELETE FROM ${S}.sso_tokens WHERE id = $1 AND kind = $2 RETURNING data, expires_at`, [String(id), kind]);
  return r.length && Number(r[0].expires_at) > Date.now() ? r[0].data : null;
}

let meta = null, metaAt = 0, jwks = null, jwksAt = 0;
async function metadata() {
  if (!meta || Date.now() - metaAt > META_TTL_MS) {
    const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/v2.0/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("Could not load Microsoft sign-in configuration (HTTP " + r.status + ").");
    meta = await r.json(); metaAt = Date.now();
  }
  return meta;
}
async function signingKey(kid) {
  const find = () => jwks && jwks.keys.find((k) => k.kid === kid);
  if (!find() || Date.now() - jwksAt > META_TTL_MS) {   // refetch on unknown kid (key rotation)
    const r = await fetch((await metadata()).jwks_uri, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("Could not load Microsoft signing keys.");
    jwks = await r.json(); jwksAt = Date.now();
  }
  const k = find();
  if (!k) throw new Error("Unknown token signing key.");
  return crypto.createPublicKey({ key: k, format: "jwk" });
}

async function verifyIdToken(idToken, nonce) {
  const [h, p, sig] = String(idToken).split(".");
  if (!sig) throw new Error("Malformed ID token.");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm.");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), await signingKey(header.kid), Buffer.from(sig, "base64url"));
  if (!ok) throw new Error("ID token signature is invalid.");
  const m = await metadata(), now = Date.now() / 1000;
  if (claims.iss !== m.issuer) throw new Error("ID token is from another tenant.");
  if (claims.aud !== CLIENT_ID) throw new Error("ID token is for another application.");
  if (claims.nonce !== nonce) throw new Error("Sign-in nonce mismatch — please try again.");
  if (!(claims.exp > now - 60) || claims.nbf > now + 60) throw new Error("ID token has expired — please try again.");
  return claims;
}

function redirectUri(req) {
  return process.env.SSO_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/auth/sso/callback`;
}

// → URL of Microsoft's sign-in page.
async function startUrl(req, next, popup) {
  const m = await metadata();
  const verifier = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(16));
  const state = await put("state", { verifier, nonce, next, popup: !!popup, redirect: redirectUri(req) }, STATE_TTL_MS);
  const q = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: redirectUri(req), response_mode: "query",
    scope: "openid profile email", state, nonce, prompt: "select_account",
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  });
  return m.authorization_endpoint + "?" + q.toString();
}

// Callback from Microsoft → { email, name, next, popup } of the verified user.
async function finish(query) {
  const st = await take("state", query.state);
  if (!st) throw new Error("Sign-in link expired — please try again.");
  if (query.error) throw Object.assign(new Error(query.error_description || query.error), { st });
  try {
    const r = await fetch((await metadata()).token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code",
        code: String(query.code || ""), redirect_uri: st.redirect, code_verifier: st.verifier, scope: "openid profile email" }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) throw new Error("Microsoft sign-in failed: " + (tok.error_description || tok.error || r.status).toString().split("\r\n")[0]);
    const c = await verifyIdToken(tok.id_token, st.nonce);
    const email = String(c.email || c.preferred_username || c.upn || "").trim().toLowerCase();
    if (!email) throw new Error("Your Microsoft account has no email address.");
    return { email, name: c.name || "", next: st.next, popup: st.popup };
  } catch (e) {
    throw Object.assign(e, { st });
  }
}

const handoff = (email) => put("handoff", { email }, HANDOFF_TTL_MS);
async function redeem(code) { const d = await take("handoff", code); return d && d.email; }

// ---- Directory lookup (Microsoft Graph, app-only) ----------------------------
// Used when an admin creates an SSO account, to make sure the email is a real,
// enabled user in the company directory. Needs the Microsoft Graph *application*
// permission User.Read.All on the app registration, with admin consent.
let graphToken = null, graphTokenExp = 0;
async function graphAccessToken() {
  if (graphToken && Date.now() < graphTokenExp - 60000) return graphToken;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw directoryError("Could not sign in to Microsoft Graph: " + String(j.error_description || j.error || r.status).split("\r\n")[0]);
  graphToken = j.access_token; graphTokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return graphToken;
}
function directoryError(msg) { return Object.assign(new Error(msg), { status: 502, code: "directory_unavailable" }); }

// → { id, displayName, upn, mail, enabled } or null when no such user exists.
async function directoryUser(email) {
  if (!enabled()) throw directoryError("Company-account (SSO) sign-in is not configured on this server.");
  const e = String(email || "").trim().toLowerCase().replace(/'/g, "''");
  const url = "https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,accountEnabled&$top=2&$filter=" +
    encodeURIComponent(`userPrincipalName eq '${e}' or mail eq '${e}'`);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + (await graphAccessToken()) }, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) {
    throw directoryError("The app is not allowed to read the company directory yet. In Entra admin center → App registrations → this app → " +
      "API permissions, add Microsoft Graph › Application › User.Read.All and click “Grant admin consent”.");
  }
  if (!r.ok) throw directoryError("Company directory lookup failed: " + ((j.error && j.error.message) || "HTTP " + r.status));
  const u = (j.value || [])[0];
  return u ? { id: u.id, displayName: u.displayName || "", upn: u.userPrincipalName || "", mail: u.mail || "", enabled: u.accountEnabled !== false } : null;
}

module.exports = { enabled, init, startUrl, finish, handoff, redeem, directoryUser };
