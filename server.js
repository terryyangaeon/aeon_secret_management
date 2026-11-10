// AEON Delight — Secret Management (密鑰管理).
// OneView module: keeps an inventory of the Microsoft Entra ID app registrations
// this tool owns, shows how long each client secret has left, warns by email,
// and rotates a secret end to end — new secret in Entra → the consuming app's
// Coolify environment variable → restart → health check → delete the old secret.
// Sign-in / accounts / Configuration follow the OneView model.
//
// Env vars:
//   DATABASE_URL              required — Postgres, e.g. postgresql://postgres:pwd@host:5432/postgres
//   DATABASE_SSL              "1" to use TLS for DATABASE_URL
//   APP_SCHEMA                schema for app tables (default appreg_app)
//   DATA_SCHEMA               schema for the registry tables (default appreg)
//   APP_SECRET                key that encrypts stored secret values — set it once, never change it
//   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD   seed one admin on first run (optional)
//   SSO_TENANT_ID / SSO_CLIENT_ID / SSO_CLIENT_SECRET   Microsoft Entra ID — sign-in AND Graph
//   SSO_REDIRECT_URI          optional, default <host>/api/auth/sso/callback
//   PASSWORD_LOGIN            "0" to allow Microsoft sign-in only (needs SSO configured)
//   COOLIFY_URL / COOLIFY_API_TOKEN   optional — otherwise saved encrypted from Configuration
//   ROTATE_ENABLED            "0" to turn the rotation scheduler off (e.g. a DEV copy)
//   ROTATE_INTERVAL_MIN       how often to check what is due (default 60)
//   HEALTH_TIMEOUT_MS         how long to wait for an app after restart (default 120000)
//   RESTART_SETTLE_MS         pause after a restart before health-checking (default 8000)
//   RUN_LOG_DAYS              keep rotation runs this long (default 180)
//   FRAME_ANCESTORS           extra origins allowed to embed this app (space-separated)
//   PORT                      default 8094 (the Dockerfile sets 8080 inside the container)
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const appdb = require("./lib/appdb");
const regdb = require("./lib/regdb");
const sso = require("./lib/sso");
const graph = require("./lib/graph");
const graphapp = require("./lib/graphapp");
const coolify = require("./lib/coolify");
const mailer = require("./lib/mailer");
const inventory = require("./lib/inventory");
const rotate = require("./lib/rotate");

const PORT = process.env.PORT || 8094;   // DEV default; the Dockerfile sets PORT explicitly
const COOKIE = "appreg_sess";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Password sign-in can only be switched off once Microsoft sign-in works, so nobody is locked out.
const PASSWORD_LOGIN = process.env.PASSWORD_LOGIN !== "0" || !sso.enabled();
// OneView embeds its modules in an iframe, so its origin must be allowed here.
// It is NOT hard-coded: the estate moved off Zeabur and the OneView production
// origin on Coolify has not been confirmed, so set FRAME_ANCESTORS to it rather
// than letting a stale guess sit in a security header.
const FRAME_ANCESTORS = ["'self'", "http://localhost:8090"]
  .concat(String(process.env.FRAME_ANCESTORS || "").split(/\s+/).filter(Boolean)).join(" ");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  // Allow OneView to embed us; nobody else.
  res.setHeader("Content-Security-Policy", "frame-ancestors " + FRAME_ANCESTORS);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Internal system: keep it out of search engines.
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
});

// ---- Cookies / sessions ---------------------------------------------------

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// Inside OneView's iframe we are a third-party site, so on HTTPS the cookie must
// be SameSite=None; Secure (Partitioned keeps it working where third-party
// cookies are blocked). Plain-http local DEV keeps SameSite=Lax.
function cookieAttrs(req, maxAgeSec) {
  const https = req.secure || req.headers["x-forwarded-proto"] === "https";
  return "; HttpOnly; Path=/; Max-Age=" + maxAgeSec + (https ? "; Secure; SameSite=None; Partitioned" : "; SameSite=Lax");
}
function tokenOf(req) { return parseCookies(req)[COOKIE] || ""; }

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function loadUser(req) {
  if (req.user !== undefined) return req.user;
  req.user = await appdb.sessionUser(tokenOf(req));
  return req.user;
}
const requireUser = wrap(async (req, res, next) => {
  if (!(await loadUser(req))) return res.status(401).json({ error: "Not signed in" });
  next();
});
const requireAdmin = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in" });
  if (u.role !== "admin") return res.status(403).json({ error: "Admins only." });
  next();
});
// Configuration, rotation and anything that reveals a secret is admin-role only.
const requireConfig = requireAdmin;

function publicUser(u) { return u && { email: u.email, name: u.name, role: u.role, bus: u.bus, accountType: u.accountType }; }
function fail(res, e, status) { res.status(status || e.status || 400).json({ error: e.message || String(e), message: e.message || String(e), code: e.code || null }); }

app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

// ---- Health ---------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---- Auth -----------------------------------------------------------------
async function startSession(req, res, email) {
  const token = crypto.randomBytes(24).toString("hex");
  await appdb.createSession(email, token, SESSION_TTL_MS);
  res.setHeader("Set-Cookie", COOKIE + "=" + token + cookieAttrs(req, SESSION_TTL_MS / 1000));
}
app.get("/api/auth/options", (_req, res) => res.json({ sso: sso.enabled(), password: PASSWORD_LOGIN }));
app.post("/api/auth/login", wrap(async (req, res) => {
  if (!PASSWORD_LOGIN) return res.status(403).json({ message: "請使用 Microsoft 帳戶登入 · Please sign in with Microsoft." });
  const b = req.body || {};
  const row = await appdb.verifyLogin(b.email, b.password);
  if (!row) {
    return setTimeout(() => res.status(401).json({ message: "電郵或密碼錯誤 · Incorrect email or password." }), 600);
  }
  await startSession(req, res, row.email);
  res.json({ ok: true });
}));

// ---- Microsoft Entra ID sign-in -------------------------------------------
const safeNext = (n) => (/^\/(?!\/)/.test(String(n || "")) && !String(n).startsWith("/login.html") ? String(n) : "/");
function escHtml(v) { return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// Popup result page: hand the one-time code (or the error) to the login page that opened it.
function popupPage(res, msg) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title><body style="font-family:sans-serif;padding:24px">
<p>${escHtml(msg.error || "Signed in — you can close this window.")}</p>
<script>try { window.opener.postMessage(${JSON.stringify(Object.assign({ type: "appreg-sso" }, msg)).replace(/</g, "\\u003c")}, location.origin); } catch (e) {}
${msg.error ? "" : "window.close();"}</script>`);
}
app.get("/api/auth/sso/start", wrap(async (req, res) => {
  if (!sso.enabled()) return res.redirect("/login.html?sso_error=" + encodeURIComponent("Microsoft sign-in is not configured."));
  res.redirect(await sso.startUrl(req, safeNext(req.query.next), req.query.popup === "1"));
}));
app.get("/api/auth/sso/callback", wrap(async (req, res) => {
  let popup = false;
  try {
    const r = await sso.finish(req.query);
    popup = r.popup;
    const acct = await appdb.ssoAccount(r.email, r.name);
    if (!acct) throw new Error(`${r.email} 未獲授權使用本系統,請聯絡管理員。 · ${r.email} has no active account here — ask an admin to add you in Account Management.`);
    if (popup) return popupPage(res, { code: await sso.handoff(acct.email) });
    await startSession(req, res, acct.email);
    res.redirect(safeNext(r.next));
  } catch (e) {
    console.warn("SSO sign-in failed:", e.message);
    if (popup || (e.st && e.st.popup)) return popupPage(res, { error: e.message });
    res.redirect("/login.html?sso_error=" + encodeURIComponent(e.message));
  }
}));
// Popup flow (inside OneView's iframe): redeem the code here so the cookie lands in the iframe's jar.
app.post("/api/auth/sso/redeem", wrap(async (req, res) => {
  const email = await sso.redeem((req.body || {}).code);
  if (!email) return res.status(401).json({ message: "Sign-in expired — please try again." });
  await startSession(req, res, email);
  res.json({ ok: true });
}));
app.post("/api/auth/logout", wrap(async (req, res) => {
  await appdb.deleteSession(tokenOf(req));
  res.setHeader("Set-Cookie", COOKIE + "=" + cookieAttrs(req, 0));
  res.json({ ok: true });
}));
app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: publicUser(req.user) }));
app.post("/api/auth/change-password", requireUser, wrap(async (req, res) => {
  try { await appdb.setOwnPassword(req.user.email, (req.body || {}).current_password, (req.body || {}).new_password); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
}));

// ---- Account management (admin role) --------------------------------------
app.get("/api/accounts", requireAdmin, wrap(async (_req, res) => {
  res.json({ accounts: await appdb.listAccounts(), bus: await appdb.listBusinessUnits(false) });
}));
// An SSO account must match an enabled user in the company directory (Entra ID).
// Fills in the name from the directory when it was left blank.
async function checkDirectory(email, body) {
  const u = await sso.directoryUser(email);
  if (!u) {
    throw Object.assign(new Error(`${email} 不在公司目錄 (AD) 中,無法建立 SSO 帳戶。請檢查電郵是否正確,或改用 Email 類型。 · ` +
      `${email} was not found in the company directory (Entra ID / AD), so it can't sign in with the company account. Check the address, or use the Email account type.`),
      { status: 422, code: "not_in_directory" });
  }
  if (!u.enabled) {
    throw Object.assign(new Error(`${email} 的公司帳戶已停用。 · The company account ${email} is disabled in the directory.`),
      { status: 422, code: "directory_disabled" });
  }
  if (!String(body.name || "").trim() && u.displayName) body.name = u.displayName;
  return u;
}
function failAccount(res, e) {
  res.status(e.status || 400).json({ error: e.message, message: e.message, code: e.code || null });
}
app.post("/api/accounts", requireAdmin, wrap(async (req, res) => {
  const b = Object.assign({}, req.body || {}, { allowNoPassword: sso.enabled() });
  try {
    if (b.accountType === "sso" && sso.enabled()) await checkDirectory(String(b.email || "").trim().toLowerCase(), b);
    res.json({ account: await appdb.createAccount(b) });
  } catch (e) { failAccount(res, e); }
}));
app.put("/api/accounts/:email", requireAdmin, wrap(async (req, res) => {
  const email = String(req.params.email).toLowerCase(), b = req.body || {};
  const demoting = b.role !== "admin" || b.active === false;
  const cur = await appdb.getAccount(email);
  if (cur && cur.role === "admin" && cur.active && demoting && (await appdb.countActiveAdmins(email)) === 0) {
    return fail(res, new Error("At least one active admin account is required."));
  }
  const body = Object.assign({}, b, { allowNoPassword: sso.enabled() });
  try {
    // Checked when an account becomes SSO (new type, or it had a password until now).
    if (body.accountType === "sso" && sso.enabled() && cur && cur.accountType !== "sso") await checkDirectory(email, body);
    res.json({ account: await appdb.updateAccount(email, body) });
  } catch (e) { failAccount(res, e); }
}));
app.delete("/api/accounts/:email", requireAdmin, wrap(async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  if (email === req.user.email) return fail(res, new Error("You can't delete your own account."));
  const cur = await appdb.getAccount(email);
  if (cur && cur.role === "admin" && cur.active && (await appdb.countActiveAdmins(email)) === 0) {
    return fail(res, new Error("At least one active admin account is required."));
  }
  await appdb.deleteAccount(email);
  res.json({ ok: true });
}));

// ---- The registry (any signed-in user may look) ---------------------------

const idOf = (v) => { const n = parseInt(v, 10); if (!(n > 0)) throw Object.assign(new Error("Bad id."), { status: 400 }); return n; };
async function mustApp(req) {
  const a = await regdb.getApp(idOf(req.params.id));
  if (!a) throw Object.assign(new Error("No such application."), { status: 404 });
  return a;
}

app.get("/api/apps", requireUser, wrap(async (_req, res) => {
  const apps = await inventory.describeAll();
  res.json({
    apps: apps.map((a) => Object.assign({}, a, { busy: rotate.isBusy(a.id) })),
    graph: graph.enabled(),
    coolify: await coolify.configured(),
    alerts: await mailer.enabled(),
    rotateEnabled: rotate.ENABLED,
    intervalMin: rotate.INTERVAL_MIN,
  });
}));

app.get("/api/apps/:id", requireUser, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    const d = await inventory.describe(a);
    d.busy = rotate.isBusy(a.id);
    d.runs = await regdb.listRuns({ appId: a.id, limit: 25 });
    res.json({ app: d });
  } catch (e) { fail(res, e); }
}));

app.get("/api/runs", requireUser, wrap(async (req, res) => {
  const appId = req.query.app ? idOf(req.query.app) : null;
  res.json({ runs: await regdb.listRuns({ appId, limit: req.query.limit }) });
}));

// ---- Rotation (admin role) ------------------------------------------------

app.post("/api/apps/:id/rotate", requireAdmin, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    if (!a.active) throw Object.assign(new Error("This application is marked inactive."), { status: 400 });
    await regdb.audit(req.user.email, "rotate.start", a.name, { appId: a.id });
    rotate.rotateManual(a, req.user.email);
    res.json({ started: true });
  } catch (e) { fail(res, e); }
}));

// Shows a secret value this tool issued. Audited; never cached.
app.post("/api/apps/:id/credentials/:keyId/reveal", requireAdmin, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    const v = await regdb.readSecretValue(a.id, req.params.keyId);
    if (!v) throw Object.assign(new Error("本系統沒有此密碼的副本(只有由本系統建立的密碼才有)。 · This app has no copy of that secret — only secrets it issued itself are stored."), { status: 404 });
    await regdb.audit(req.user.email, "secret.reveal", a.name, { keyId: req.params.keyId });
    res.setHeader("Cache-Control", "no-store");
    res.json({ value: v });
  } catch (e) { fail(res, e); }
}));

app.delete("/api/apps/:id/credentials/:keyId", requireAdmin, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    const cur = await regdb.currentCredential(a.id);
    if (cur && cur.key_id === req.params.keyId) {
      throw Object.assign(new Error("這是目前使用中的密碼,不能刪除。 · That is the secret the app is currently using — rotate instead of deleting it."), { status: 400 });
    }
    await graphapp.removePassword(a.entra_object_id, req.params.keyId);
    await regdb.deleteCredentialRow(a.id, req.params.keyId);
    await regdb.deleteSecretValue(a.id, req.params.keyId);
    await regdb.audit(req.user.email, "secret.delete", a.name, { keyId: req.params.keyId });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
}));

// Which credential the live app is actually using, when the guess was wrong.
app.post("/api/apps/:id/credentials/:keyId/current", requireAdmin, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    await regdb.setCurrent(a.id, req.params.keyId);
    await regdb.audit(req.user.email, "secret.setCurrent", a.name, { keyId: req.params.keyId });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
}));

// ---- Configuration (admin role only) --------------------------------------

app.get("/api/config/status", requireUser, (req, res) => res.json({ allowed: req.user.role === "admin" }));

// Every registration this app is an Owner of — the pick list when adding one.
app.get("/api/config/discover", requireConfig, wrap(async (_req, res) => {
  try {
    const owned = await graphapp.listOwned();
    const known = await regdb.listApps();
    const byOid = {};
    known.forEach((k) => { byOid[k.entra_object_id] = k.id; });
    res.json({
      apps: owned.map((a) => Object.assign({}, a, { managedId: byOid[a.objectId] || null })),
      self: await graphapp.self().catch(() => null),
    });
  } catch (e) { fail(res, e); }
}));

app.get("/api/config/apps", requireConfig, wrap(async (_req, res) => res.json({ apps: await inventory.describeAll() })));

app.post("/api/config/apps", requireConfig, wrap(async (req, res) => {
  try {
    const b = req.body || {};
    // Read it from Entra first, so a typo'd object id fails here rather than at rotation time.
    const live = await graphapp.getApp(String(b.entraObjectId || "").trim());
    const row = await regdb.createApp(Object.assign({}, b, {
      name: String(b.name || "").trim() || live.name,
      clientId: live.clientId,
    }));
    await regdb.syncCredentials(row.id, live.credentials);
    await regdb.audit(req.user.email, "app.create", row.name, { appId: row.id, objectId: row.entra_object_id });
    res.json({ app: await inventory.describe(row) });
  } catch (e) { fail(res, e); }
}));

app.put("/api/config/apps/:id", requireConfig, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    const row = await regdb.updateApp(a.id, req.body || {});
    await regdb.audit(req.user.email, "app.update", row.name, { appId: row.id });
    res.json({ app: await inventory.describe(row) });
  } catch (e) { fail(res, e); }
}));

app.delete("/api/config/apps/:id", requireConfig, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    if (rotate.isBusy(a.id)) throw Object.assign(new Error("A rotation is running for this application."), { status: 409 });
    await regdb.deleteApp(a.id);
    await regdb.audit(req.user.email, "app.delete", a.name, { appId: a.id });
    // Only this app's own record of it goes; the Entra registration is untouched.
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
}));

app.get("/api/config/apps/:id/targets", requireConfig, wrap(async (req, res) => {
  try { res.json({ targets: await regdb.listTargets((await mustApp(req)).id) }); } catch (e) { fail(res, e); }
}));
app.post("/api/config/apps/:id/targets", requireConfig, wrap(async (req, res) => {
  try {
    const a = await mustApp(req);
    const t = await regdb.createTarget(a.id, req.body || {});
    await regdb.audit(req.user.email, "target.create", a.name, { targetId: t.id, varName: t.var_name });
    res.json({ target: t });
  } catch (e) { fail(res, e); }
}));
app.put("/api/config/targets/:tid", requireConfig, wrap(async (req, res) => {
  try { res.json({ target: await regdb.updateTarget(idOf(req.params.tid), req.body || {}) }); } catch (e) { fail(res, e); }
}));
app.delete("/api/config/targets/:tid", requireConfig, wrap(async (req, res) => {
  try { await regdb.deleteTarget(idOf(req.params.tid)); res.json({ ok: true }); } catch (e) { fail(res, e); }
}));

// Check a target without changing anything: does the variable exist, and can we read it back?
app.post("/api/config/targets/:tid/test", requireConfig, wrap(async (req, res) => {
  try {
    const t = await regdb.getTarget(idOf(req.params.tid));
    if (!t) throw Object.assign(new Error("No such target."), { status: 404 });
    const v = await coolify.getVariable(t.app_uuid, t.var_name);
    let health = null;
    if (t.health_url) {
      health = await fetch(t.health_url, { redirect: "follow", signal: AbortSignal.timeout(10000) })
        .then((r) => ({ ok: r.status < 400, status: r.status })).catch((e) => ({ ok: false, status: 0, error: e.message }));
    }
    res.json({ exists: v.exists, readable: v.readable, hint: v.value ? String(v.value).slice(0, 3) + "…" : "", health });
  } catch (e) { fail(res, e); }
}));

// ---- Coolify connection ---------------------------------------------------

app.get("/api/config/coolify", requireConfig, wrap(async (_req, res) => {
  const c = await coolify.getConfig();
  res.json({ configured: await coolify.configured(), fromEnv: !!c.fromEnv, baseUrl: c.baseUrl });
}));
app.post("/api/config/coolify", requireConfig, wrap(async (req, res) => {
  try {
    const c = await coolify.getConfig();
    if (c.fromEnv) throw new Error("The connection comes from the COOLIFY_URL / COOLIFY_API_TOKEN environment variables — change it there.");
    const b = req.body || {};
    await coolify.setConfig(b.baseUrl, b.token);
    await regdb.audit(req.user.email, "coolify.connect", String(b.baseUrl || ""), {});
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
}));
app.get("/api/config/coolify/test", requireConfig, wrap(async (_req, res) => {
  try { res.json(await coolify.test()); } catch (e) { fail(res, e); }
}));
app.get("/api/config/coolify/applications", requireConfig, wrap(async (_req, res) => {
  try { res.json({ applications: await coolify.listApplications() }); } catch (e) { fail(res, e); }
}));
// Variable NAMES only — values are never sent to the browser here.
app.get("/api/config/coolify/variables", requireConfig, wrap(async (req, res) => {
  try {
    const r = await coolify.listVariables(String(req.query.app || ""));
    res.json({ keys: Object.keys(r.vars).sort(), readable: r.values });
  } catch (e) { fail(res, e); }
}));

// ---- Alerts ---------------------------------------------------------------

app.get("/api/config/alerts", requireConfig, wrap(async (_req, res) => {
  res.json({ alerts: await mailer.getConfig(), graph: graph.enabled() });
}));
app.put("/api/config/alerts", requireConfig, wrap(async (req, res) => {
  try { res.json({ alerts: await mailer.setConfig(req.body || {}) }); } catch (e) { fail(res, e); }
}));
app.post("/api/config/alerts/test", requireConfig, wrap(async (req, res) => {
  try {
    const sent = await mailer.send("Test — Secret Management",
      "<p>這是一封測試郵件。 · This is a test message. Expiry warnings and rotation reports will look like this.</p>" +
      mailer.table([["Sent by", req.user.email], ["At", new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"]]));
    if (!sent) throw new Error("寄件者或收件者未設定。 · No sender or recipients configured.");
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
}));

// ---- Maintenance ----------------------------------------------------------

app.post("/api/config/refresh", requireConfig, wrap(async (req, res) => {
  try {
    const r = await inventory.refresh();
    await inventory.sendExpiryAlerts().catch((e) => console.warn("expiry alerts:", e.message));
    res.json(r);
  } catch (e) { fail(res, e); }
}));
app.get("/api/config/audit", requireConfig, wrap(async (req, res) => res.json({ entries: await regdb.listAudit(req.query.limit) })));

// ---- Static pages ---------------------------------------------------------
// HTML pages carry a <!--#navbar--> marker that is replaced with the shared
// OneView navbar (partials/navbar.html), so the bar is maintained in one place.
const PUBLIC_DIR = path.join(__dirname, "public");
const NAVBAR_HTML = fs.readFileSync(path.join(__dirname, "partials", "navbar.html"), "utf8");
// "/" shows the sign-in page until the visitor is signed in. That page carries no password
// field until "email & password" is expanded, so the domain doesn't open onto a password form.
app.get(/^\/([A-Za-z0-9_-]+\.html)?$/, wrap(async (req, res, next) => {
  let page = req.params[0] || "index.html";
  if (!req.params[0] && !(await loadUser(req).catch(() => null))) page = "login.html";
  const file = path.join(PUBLIC_DIR, page);
  fs.readFile(file, "utf8", (err, html) => {
    if (err) return next();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(html.replace("<!--#navbar-->", NAVBAR_HTML));
  });
}));
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) { if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); },
}));
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message || "Server error" }); });

appdb.init()
  .then(() => sso.init())
  .then(() => regdb.init())
  .then(() => {
    console.log("Tables ready (schemas " + appdb.SCHEMA + ", " + regdb.SCHEMA + ")");
    console.log("Microsoft sign-in " + (sso.enabled() ? "enabled" : "not configured") + "; password sign-in " + (PASSWORD_LOGIN ? "on" : "off"));
    rotate.start();
  })
  .catch((e) => console.error("DB init failed:", e.message))
  .then(() => app.listen(PORT, () => console.log("Secret Management listening on :" + PORT)));
