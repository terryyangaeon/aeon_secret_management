// App database (accounts, business units, sessions, settings) — Postgres from
// DATABASE_URL. Tables live in their own schema (APP_SCHEMA, default
// "appreg_app") so they never clash with the registry tables (DATA_SCHEMA,
// default "appreg") created by lib/regdb.js.
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SCHEMA = process.env.APP_SCHEMA || "appreg_app";
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error("APP_SCHEMA must be a lowercase identifier");
const S = '"' + SCHEMA + '"';

// Seed business units (code, name). Only inserted when the table is empty.
const SEED_BUS = [["IT", "Information Technology"]];

if (!DATABASE_URL) console.warn("DATABASE_URL is not set — the app database is unavailable.");
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: /^(1|true|yes)$/i.test(process.env.DATABASE_SSL || "") ? { rejectUnauthorized: false } : false,
  max: 5, idleTimeoutMillis: 60000, connectionTimeoutMillis: 8000,
}) : null;
if (pool) pool.on("error", (e) => console.warn("app pg pool error:", e.message));

async function q(sql, params) {
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  return (await pool.query(sql, params)).rows;
}

async function init() {
  await q(`CREATE SCHEMA IF NOT EXISTS ${S}`);
  await q(`
    CREATE TABLE IF NOT EXISTS ${S}.accounts (
      email      TEXT PRIMARY KEY,
      name       TEXT,
      pass_hash  TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${S}.business_units (
      code       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    -- A row grants that account read access to that business unit's rows;
    -- role='admin' accounts see every business unit.
    CREATE TABLE IF NOT EXISTS ${S}.account_bus (
      email   TEXT NOT NULL REFERENCES ${S}.accounts(email) ON DELETE CASCADE ON UPDATE CASCADE,
      bu_code TEXT NOT NULL REFERENCES ${S}.business_units(code) ON DELETE CASCADE ON UPDATE CASCADE,
      PRIMARY KEY (email, bu_code)
    );
    CREATE TABLE IF NOT EXISTS ${S}.sessions (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL REFERENCES ${S}.accounts(email) ON DELETE CASCADE ON UPDATE CASCADE,
      expires_at BIGINT NOT NULL,
      cfg_until  BIGINT NOT NULL DEFAULT 0     -- Configuration unlocked (admin password) until
    );
    CREATE TABLE IF NOT EXISTS ${S}.settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
  const n = await q(`SELECT count(*)::int AS n FROM ${S}.business_units`);
  if (n[0].n === 0) {
    for (let i = 0; i < SEED_BUS.length; i++) {
      await q(`INSERT INTO ${S}.business_units (code, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [SEED_BUS[i][0], SEED_BUS[i][1], i]);
    }
  }
  await bootstrapAdmin();
}

// Optional first-run admin from env vars (no-op once any account exists).
async function bootstrapAdmin() {
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const pw = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
  if (!email || !pw) return;
  const n = await q(`SELECT count(*)::int AS n FROM ${S}.accounts`);
  if (n[0].n > 0) return;
  await q(`INSERT INTO ${S}.accounts (email, name, pass_hash, role) VALUES ($1, $2, $3, 'admin') ON CONFLICT DO NOTHING`,
    [email, email.split("@")[0], bcrypt.hashSync(pw, 10)]);
  console.log("Bootstrapped admin account " + email);
}

// ---- Settings ----
async function getSetting(key, fallback) {
  const r = await q(`SELECT value FROM ${S}.settings WHERE key = $1`, [key]);
  return r.length ? r[0].value : fallback;
}
async function setSetting(key, value) {
  await q(`INSERT INTO ${S}.settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
}

// ---- Business units ----
async function listBusinessUnits(activeOnly) {
  return q(`SELECT code, name, active FROM ${S}.business_units ${activeOnly ? "WHERE active" : ""} ORDER BY sort_order, code`);
}
function normCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,20}$/.test(c)) throw new Error("Code must be 1–20 letters, digits, - or _.");
  return c;
}
async function createBusinessUnit(code, name) {
  code = normCode(code); name = String(name || "").trim();
  if (!name) throw new Error("Name is required.");
  const exists = await q(`SELECT 1 FROM ${S}.business_units WHERE code = $1`, [code]);
  if (exists.length) throw new Error("Business unit " + code + " already exists.");
  await q(`INSERT INTO ${S}.business_units (code, name, sort_order)
           VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ${S}.business_units))`, [code, name]);
}
async function updateBusinessUnit(code, name, active) {
  name = String(name || "").trim();
  if (!name) throw new Error("Name is required.");
  const r = await q(`UPDATE ${S}.business_units SET name = $2, active = $3 WHERE code = $1 RETURNING code`, [code, name, !!active]);
  if (!r.length) throw new Error("Unknown business unit.");
}
async function deleteBusinessUnit(code) {
  await q(`DELETE FROM ${S}.business_units WHERE code = $1`, [code]);
}

// ---- Accounts ----
// Accounts created for Microsoft sign-in only carry this placeholder instead of a bcrypt hash.
const NO_PASSWORD = "!sso-only";
const hasPassword = (row) => /^\$2[aby]\$/.test(row.pass_hash || "");
function pubUser(row, bus) {
  return row && { email: row.email, name: row.name || "", role: row.role, active: row.active, bus: bus || [],
                  hasPassword: hasPassword(row), accountType: hasPassword(row) ? "email" : "sso" };
}
async function accountBus(email) {
  return (await q(`SELECT bu_code FROM ${S}.account_bus WHERE email = $1 ORDER BY bu_code`, [email])).map((r) => r.bu_code);
}
async function getAccountRaw(email) {
  const r = await q(`SELECT * FROM ${S}.accounts WHERE email = $1`, [String(email || "").trim().toLowerCase()]);
  return r[0] || null;
}
async function getAccount(email) {
  const row = await getAccountRaw(email);
  return row ? pubUser(row, await accountBus(row.email)) : null;
}
async function listAccounts() {
  const rows = await q(`SELECT * FROM ${S}.accounts ORDER BY role, email`);
  const grants = await q(`SELECT email, bu_code FROM ${S}.account_bus ORDER BY bu_code`);
  return rows.map((r) => pubUser(r, grants.filter((g) => g.email === r.email).map((g) => g.bu_code)));
}
function checkPassword(pw) {
  if (String(pw || "").length < 6) throw new Error("Password must be at least 6 characters.");
}
function normType(type, password) {
  if (type === "sso" || type === "email") return type;
  return password ? "email" : "sso";
}
// a.allowNoPassword is set by the server when Microsoft sign-in is configured.
function requireSso(a) {
  if (!a.allowNoPassword) throw new Error("Company-account (SSO) sign-in is not configured on this server — choose Email.");
}
function normRole(role) { return role === "admin" ? "admin" : "user"; }
async function setBus(email, bus) {
  await q(`DELETE FROM ${S}.account_bus WHERE email = $1`, [email]);
  for (const code of Array.isArray(bus) ? bus : []) {
    await q(`INSERT INTO ${S}.account_bus (email, bu_code)
             SELECT $1, code FROM ${S}.business_units WHERE code = $2 ON CONFLICT DO NOTHING`, [email, String(code)]);
  }
}
async function createAccount(a) {
  const email = String(a.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  // accountType "sso": signs in with the company (Microsoft) account only, no password here.
  // "email": email + password. Without a type: a password makes it "email", none makes it "sso".
  const type = normType(a.accountType, a.password);
  if (type === "sso") requireSso(a);
  else checkPassword(a.password);
  if (await getAccountRaw(email)) throw new Error("An account with that email already exists.");
  await q(`INSERT INTO ${S}.accounts (email, name, pass_hash, role, active) VALUES ($1, $2, $3, $4, $5)`,
    [email, String(a.name || "").trim(), type === "sso" ? NO_PASSWORD : bcrypt.hashSync(String(a.password), 10), normRole(a.role), a.active !== false]);
  await setBus(email, a.bus);
  return getAccount(email);
}
async function updateAccount(email, a) {
  const row = await getAccountRaw(email);
  if (!row) throw new Error("Unknown account.");
  let hash = null;                                   // null = keep the current password / type
  if (a.accountType === "sso") { if (hasPassword(row)) requireSso(a); hash = hasPassword(row) ? NO_PASSWORD : null; }
  else if (a.password) { checkPassword(a.password); hash = bcrypt.hashSync(String(a.password), 10); }
  else if (a.accountType === "email" && !hasPassword(row)) throw new Error("Set a password to change this account to email sign-in.");
  await q(`UPDATE ${S}.accounts SET name = $2, role = $3, active = $4 ${hash ? ", pass_hash = $5" : ""} WHERE email = $1`,
    [row.email, String(a.name || "").trim(), normRole(a.role), a.active !== false].concat(hash ? [hash] : []));
  await setBus(row.email, a.bus);
  if (a.active === false) await q(`DELETE FROM ${S}.sessions WHERE email = $1`, [row.email]);
  return getAccount(row.email);
}
// Active SSO-type account for a Microsoft sign-in, filling in the name from Entra if it was left blank.
// Email-type accounts (they have a password) sign in with email + password only.
async function ssoAccount(email, name) {
  const row = await getAccountRaw(email);
  if (!row || !row.active) return null;
  if (hasPassword(row)) {
    throw new Error(`${row.email} 是電郵帳戶,請使用電郵及密碼登入。 · ${row.email} is an Email account — sign in with email & password.`);
  }
  if (!row.name && name) await q(`UPDATE ${S}.accounts SET name = $2 WHERE email = $1`, [row.email, String(name).slice(0, 200)]);
  return row;
}
async function deleteAccount(email) { await q(`DELETE FROM ${S}.accounts WHERE email = $1`, [email]); }
async function countActiveAdmins(exceptEmail) {
  const r = await q(`SELECT count(*)::int AS n FROM ${S}.accounts WHERE role = 'admin' AND active AND email <> $1`, [exceptEmail || ""]);
  return r[0].n;
}
async function verifyLogin(email, pw) {
  const row = await getAccountRaw(email);
  if (!row || !row.active || !hasPassword(row)) return null;
  return bcrypt.compareSync(String(pw || ""), row.pass_hash) ? row : null;
}
async function setOwnPassword(email, current, next) {
  const row = await getAccountRaw(email);
  if (row && !hasPassword(row)) throw new Error("This account signs in with Microsoft and has no password here.");
  if (!row || !bcrypt.compareSync(String(current || ""), row.pass_hash)) throw new Error("Current password is incorrect.");
  checkPassword(next);
  await q(`UPDATE ${S}.accounts SET pass_hash = $2 WHERE email = $1`, [row.email, bcrypt.hashSync(String(next), 10)]);
}

// ---- Sessions ----
async function createSession(email, token, ttlMs) {
  await q(`DELETE FROM ${S}.sessions WHERE expires_at < $1`, [Date.now()]);
  await q(`INSERT INTO ${S}.sessions (token, email, expires_at) VALUES ($1, $2, $3)`, [token, email, Date.now() + ttlMs]);
}
async function sessionUser(token) {
  if (!token) return null;
  const r = await q(`SELECT a.*, s.cfg_until FROM ${S}.sessions s JOIN ${S}.accounts a ON a.email = s.email
                     WHERE s.token = $1 AND s.expires_at > $2 AND a.active`, [token, Date.now()]);
  if (!r.length) return null;
  const u = pubUser(r[0], await accountBus(r[0].email));
  u.cfgUntil = Number(r[0].cfg_until) || 0;
  return u;
}
async function deleteSession(token) { if (token) await q(`DELETE FROM ${S}.sessions WHERE token = $1`, [token]); }
async function setSessionConfigUnlock(token, until) { await q(`UPDATE ${S}.sessions SET cfg_until = $2 WHERE token = $1`, [token, until]); }
async function clearConfigUnlocks() { await q(`UPDATE ${S}.sessions SET cfg_until = 0`); }

module.exports = {
  DATABASE_URL, SCHEMA, pool, q, init, getSetting, setSetting,
  listBusinessUnits, createBusinessUnit, updateBusinessUnit, deleteBusinessUnit,
  listAccounts, getAccount, createAccount, updateAccount, deleteAccount, countActiveAdmins, verifyLogin, setOwnPassword, ssoAccount,
  createSession, sessionUser, deleteSession, setSessionConfigUnlock, clearConfigUnlocks,
};
