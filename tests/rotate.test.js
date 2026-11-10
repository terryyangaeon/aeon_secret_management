// End-to-end rotation tests against a real Postgres, with Entra and Coolify
// stubbed. Start the database first:  docker compose up -d db
//
//   DATABASE_URL=postgresql://postgres:devpw@localhost:5435/appreg_dev node tests/rotate.test.js
//
// What it proves: the new secret is stored before anything risky happens, the
// old secret survives every failure path, a failed rotation puts the variable
// back, and nothing is deleted from Entra unless the app answered a health check.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:devpw@localhost:5435/appreg_dev";
process.env.APP_SECRET = "test-secret-key";
process.env.APP_SCHEMA = "appreg_app_test";
process.env.DATA_SCHEMA = "appreg_test";
process.env.ROTATE_ENABLED = "0";          // no background sweep during tests
process.env.HEALTH_TIMEOUT_MS = "2500";    // fail fast
process.env.RESTART_SETTLE_MS = "0";

const assert = require("assert");
const http = require("http");

const appdb = require("../lib/appdb");
const regdb = require("../lib/regdb");
const graphapp = require("../lib/graphapp");
const coolify = require("../lib/coolify");
const mailer = require("../lib/mailer");
const rotate = require("../lib/rotate");

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + (e && e.stack || e)); process.exitCode = 1; }
}
function g(n) { console.log("\n" + n); }

// ---- Stubs ------------------------------------------------------------------

// A fake Entra app registration plus a fake Coolify application.
const fake = {
  secrets: [],          // [{keyId, endsAt, displayName}]
  vars: {},             // Coolify application variables
  restarts: 0,
  mails: [],
  healthOk: true,
  failWriteOn: null,    // var name whose write should blow up
  nextKey: 1,
};

function installStubs() {
  graphapp.addPassword = async (_oid, o) => {
    const keyId = "key-" + (fake.nextKey++);
    fake.secrets.push({ keyId, endsAt: o.endDateTime, displayName: o.displayName });
    return { keyId, secretText: "VALUE-" + keyId, endsAt: o.endDateTime };
  };
  graphapp.removePassword = async (_oid, keyId) => {
    const i = fake.secrets.findIndex((s) => s.keyId === keyId);
    if (i < 0) throw new Error("no such key " + keyId);
    fake.secrets.splice(i, 1);
    return true;
  };
  graphapp.getApp = async () => ({
    objectId: "obj-1", clientId: "client-1", name: "Fake App", redirectUris: [],
    credentials: fake.secrets.map((s) => ({ keyId: s.keyId, kind: "secret", displayName: s.displayName, hint: "", startsAt: null, endsAt: s.endsAt })),
  });

  coolify.configured = async () => true;
  coolify.getVariable = async (_uuid, name) => ({
    exists: name in fake.vars, value: fake.vars[name] === undefined ? null : fake.vars[name], readable: name in fake.vars,
  });
  coolify.setVariable = async (_uuid, name, value) => {
    if (fake.failWriteOn === name) throw new Error("Coolify write refused (test)");
    fake.vars[name] = value;
    return { mode: "patch", key: name };
  };
  coolify.restartApplication = async () => { fake.restarts++; return "dep-test"; };

  mailer.send = async (subject, html) => { fake.mails.push({ subject, html }); return true; };
  mailer.getConfig = async () => ({ sender: "a@b.com", recipients: ["c@d.com"], thresholds: [30], onRotation: true });
  mailer.enabled = async () => true;
}

function resetFake() {
  fake.secrets = [{ keyId: "key-old", endsAt: new Date(Date.now() + 10 * 864e5).toISOString(), displayName: "original" }];
  fake.vars = { DATABASE_URL: "postgres://keep-me", SSO_CLIENT_SECRET: "OLD-VALUE" };
  fake.restarts = 0;
  fake.mails = [];
  fake.healthOk = true;
  fake.failWriteOn = null;
  fake.nextKey = 1;
}

// ---- Health endpoint we control --------------------------------------------

let server, healthUrl;
function startHealth() {
  return new Promise((res) => {
    server = http.createServer((_req, r) => {
      if (fake.healthOk) { r.writeHead(200, { "Content-Type": "application/json" }); r.end('{"ok":true}'); }
      else { r.writeHead(503); r.end("down"); }
    });
    server.listen(0, "127.0.0.1", () => { healthUrl = "http://127.0.0.1:" + server.address().port + "/api/health"; res(); });
  });
}

// ---- Fixtures ---------------------------------------------------------------

const S = () => '"' + regdb.SCHEMA + '"';
async function freshApp(opts) {
  await appdb.q(`TRUNCATE ${S()}.managed_apps RESTART IDENTITY CASCADE`);
  const a = await regdb.createApp(Object.assign({
    name: "Fake App", entraObjectId: "obj-1", clientId: "client-1",
    appUrl: healthUrl.replace("/api/health", ""), lifetimeMonths: 12,
  }, opts || {}));
  const live = await graphapp.getApp();
  await regdb.syncCredentials(a.id, live.credentials);
  return a;
}
async function addTarget(appId, varName, order) {
  return regdb.createTarget(appId, {
    label: varName, appUuid: "coolify-app-1", appName: "Svc", varName, restart: true,
    healthUrl: order ? "" : healthUrl, sortOrder: order || 0,
  });
}

// ---- Tests -------------------------------------------------------------------

(async () => {
  installStubs();
  await startHealth();
  await appdb.init();
  await regdb.init();

  g("happy path");
  await t("rotation replaces the secret, the variable and the old key", async () => {
    resetFake();
    const a = await freshApp();
    await addTarget(a.id, "SSO_CLIENT_SECRET");
    const r = await rotate.rotateApp(await regdb.getApp(a.id), "manual", "tester@x.com");

    assert.ok(r.ok);
    assert.strictEqual(fake.secrets.length, 1, "exactly one secret should remain in Entra");
    assert.strictEqual(fake.secrets[0].keyId, r.keyId, "the remaining secret is the new one");
    assert.strictEqual(fake.vars.SSO_CLIENT_SECRET, "VALUE-" + r.keyId, "the variable holds the new value");
    assert.strictEqual(fake.vars.DATABASE_URL, "postgres://keep-me", "other variables untouched");
    assert.strictEqual(fake.restarts, 1);

    const run = (await regdb.listRuns({ appId: a.id }))[0];
    assert.strictEqual(run.status, "ok");
    assert.strictEqual(run.new_key_id, r.keyId);
    assert.strictEqual(run.old_key_id, "key-old");
    const steps = run.steps.map((s) => s.step);
    assert.deepStrictEqual(steps, ["start", "entra.addPassword", "snapshot", "coolify.setVariable",
      "coolify.restart", "health", "entra.removePassword"]);
    assert.ok(run.steps.every((s) => s.ok), "every step should have succeeded");
  });

  await t("the new secret value is stored encrypted and can be read back", async () => {
    const a = (await regdb.listApps())[0];
    const cur = await regdb.currentCredential(a.id);
    assert.ok(cur.created_here, "the new credential is marked as issued here");
    assert.strictEqual(await regdb.readSecretValue(a.id, cur.key_id), "VALUE-" + cur.key_id);
    const raw = await appdb.q(`SELECT value_enc FROM ${S()}.secret_values WHERE app_id=$1`, [a.id]);
    assert.ok(/^v1:/.test(raw[0].value_enc) && !/VALUE-/.test(raw[0].value_enc), "stored ciphertext, not plaintext");
  });

  await t("the old secret's stored copy and alerts are cleaned up", async () => {
    const a = (await regdb.listApps())[0];
    assert.strictEqual(await regdb.hasSecretValue(a.id, "key-old"), false);
    const creds = await regdb.listCredentials(a.id);
    assert.strictEqual(creds.length, 1, "the old credential row is gone");
  });

  await t("a success email is sent", async () => {
    assert.strictEqual(fake.mails.length, 1);
    assert.ok(/^\[OK\]/.test(fake.mails[0].subject), fake.mails[0].subject);
  });

  g("failure paths — the old secret must always survive");
  await t("a failing health check rolls the variable back and removes the NEW key", async () => {
    resetFake();
    fake.healthOk = false;
    const a = await freshApp();
    await addTarget(a.id, "SSO_CLIENT_SECRET");

    const row = await regdb.getApp(a.id);
    await assert.rejects(() => rotate.rotateApp(row, "manual", "t"), /Health check failed/);

    assert.deepStrictEqual(fake.secrets.map((s) => s.keyId), ["key-old"], "only the old secret remains");
    assert.strictEqual(fake.vars.SSO_CLIENT_SECRET, "OLD-VALUE", "the variable was put back");
    const run = (await regdb.listRuns({ appId: a.id }))[0];
    assert.strictEqual(run.status, "rolled_back");
    const names = run.steps.map((s) => s.step);
    assert.ok(names.includes("rollback.variables") && names.includes("rollback.removeNewSecret"), names.join(","));
    assert.ok(/ROLLED BACK/.test(fake.mails[fake.mails.length - 1].subject));
  });

  await t("a Coolify write failure on the second target restores the first", async () => {
    resetFake();
    fake.vars.OTHER_SECRET = "OTHER-OLD";
    const a = await freshApp();
    await addTarget(a.id, "SSO_CLIENT_SECRET", 0);
    await addTarget(a.id, "OTHER_SECRET", 1);
    fake.failWriteOn = "OTHER_SECRET";

    const row = await regdb.getApp(a.id);
    await assert.rejects(() => rotate.rotateApp(row, "manual", "t"), /Coolify write refused/);

    assert.deepStrictEqual(fake.secrets.map((s) => s.keyId), ["key-old"]);
    assert.strictEqual(fake.vars.SSO_CLIENT_SECRET, "OLD-VALUE", "the first target was restored");
    assert.strictEqual(fake.vars.OTHER_SECRET, "OTHER-OLD", "the second was never written");
    assert.strictEqual((await regdb.listRuns({ appId: a.id }))[0].status, "rolled_back");
  });

  await t("an app with no delivery target fails before touching Entra", async () => {
    resetFake();
    const a = await freshApp();
    const row = await regdb.getApp(a.id);
    await assert.rejects(() => rotate.rotateApp(row, "manual", "t"), /No delivery target/);
    assert.deepStrictEqual(fake.secrets.map((s) => s.keyId), ["key-old"], "Entra untouched");
    const run = (await regdb.listRuns({ appId: a.id }))[0];
    assert.strictEqual(run.status, "rolled_back");
    assert.ok(!run.steps.some((s) => s.step === "entra.addPassword"));
  });

  await t("Entra refusing addPassword leaves everything alone", async () => {
    resetFake();
    const a = await freshApp();
    await addTarget(a.id, "SSO_CLIENT_SECRET");
    const real = graphapp.addPassword;
    graphapp.addPassword = async () => { throw new Error("Insufficient privileges to complete the operation."); };
    try {
      const row = await regdb.getApp(a.id);
      await assert.rejects(() => rotate.rotateApp(row, "manual", "t"), /Insufficient privileges/);
    } finally { graphapp.addPassword = real; }
    assert.strictEqual(fake.vars.SSO_CLIENT_SECRET, "OLD-VALUE");
    assert.deepStrictEqual(fake.secrets.map((s) => s.keyId), ["key-old"]);
  });

  await t("a failed removePassword still leaves the rotation successful", async () => {
    resetFake();
    const a = await freshApp();
    await addTarget(a.id, "SSO_CLIENT_SECRET");
    const real = graphapp.removePassword;
    graphapp.removePassword = async () => { throw new Error("transient Graph error"); };
    const row = await regdb.getApp(a.id);
    let r;
    try { r = await rotate.rotateApp(row, "manual", "t"); }
    finally { graphapp.removePassword = real; }
    assert.ok(r.ok, "the rotation itself worked");
    const run = (await regdb.listRuns({ appId: a.id }))[0];
    assert.strictEqual(run.status, "ok");
    const rm = run.steps.find((s) => s.step === "entra.removePassword");
    assert.strictEqual(rm.ok, false, "the tidy-up step is recorded as failed");
  });

  g("concurrency and bookkeeping");
  await t("two rotations of one app cannot overlap", async () => {
    resetFake();
    const a = await freshApp();
    await addTarget(a.id, "SSO_CLIENT_SECRET");
    const row = await regdb.getApp(a.id);
    const first = rotate.rotateApp(row, "manual", "t");
    await assert.rejects(() => rotate.rotateApp(row, "manual", "t"), /already running/);
    await first;
  });

  await t("last_rotated_at is stamped on success only", async () => {
    const a = (await regdb.listApps())[0];
    assert.ok(a.last_rotated_at, "set after the successful rotation above");
  });

  await t("releaseStaleRuns closes a run abandoned by a restart", async () => {
    const a = (await regdb.listApps())[0];
    const id = await regdb.startRun(a.id, "schedule", "");
    await appdb.q(`UPDATE ${S()}.rotation_runs SET started_at = NOW() - interval '2 hours' WHERE id = $1`, [id]);
    await regdb.releaseStaleRuns();
    assert.strictEqual((await regdb.getRun(id)).status, "error");
  });

  await t("claimAlert only lets one warning through per threshold", async () => {
    const a = (await regdb.listApps())[0];
    assert.strictEqual(await regdb.claimAlert(a.id, "k1", 30), true);
    assert.strictEqual(await regdb.claimAlert(a.id, "k1", 30), false);
    assert.strictEqual(await regdb.claimAlert(a.id, "k1", 7), true, "a different threshold is separate");
    await regdb.clearAlerts(a.id, "k1");
    assert.strictEqual(await regdb.claimAlert(a.id, "k1", 30), true, "cleared after the secret is replaced");
  });

  // ---- Clean up ----
  await appdb.q(`DROP SCHEMA IF EXISTS ${S()} CASCADE`);
  await appdb.q(`DROP SCHEMA IF EXISTS "${appdb.SCHEMA}" CASCADE`);
  server.close();
  await appdb.pool.end();

  console.log("\n" + pass + " checks passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
