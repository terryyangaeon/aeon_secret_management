// Pure-logic tests — no database. Network calls are stubbed at global fetch.
//   node tests/unit.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused";
process.env.COOLIFY_URL = "https://coolify-kvm.aeondelightasia.online";   // so coolify.getConfig()
process.env.COOLIFY_API_TOKEN = "test-token";                           // never touches the DB
const assert = require("assert");

const inventory = require("../lib/inventory");
const coolify = require("../lib/coolify");
const mailer = require("../lib/mailer");

let pass = 0, group = "";
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + (e && e.message)); process.exitCode = 1; }
}
function g(name) { group = name; console.log("\n" + name); }

const DAY = 24 * 3600 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();
const app = (o) => Object.assign({
  id: 1, name: "X", active: true, auto_rotate: true, rotation_mode: "expiry",
  rotate_before_days: 30, monthly_day: 1, lifetime_months: 12, last_rotated_at: null,
}, o);
const cred = (d) => ({ key_id: "k", ends_at: inDays(d) });

// Replace global fetch for the duration of fn.
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const jsonRes = (body, status) => ({
  ok: (status || 200) < 400, status: status || 200,
  json: async () => body,
});

(async () => {

g("inventory — days and status");
await t("daysLeft counts whole days, rounding down", () => {
  // Off-boundary offsets, so the assertion can't flip on sub-millisecond timing.
  assert.strictEqual(inventory.daysLeft(inDays(10.5)), 10);
  assert.strictEqual(inventory.daysLeft(inDays(0.5)), 0, "expiring later today is 0 days left");
  assert.strictEqual(inventory.daysLeft(inDays(-0.5)), -1, "already expired is negative");
  assert.strictEqual(inventory.daysLeft(null), null);
});
await t("statusOf thresholds", () => {
  assert.strictEqual(inventory.statusOf(90), "ok");
  assert.strictEqual(inventory.statusOf(31), "ok");
  assert.strictEqual(inventory.statusOf(30), "warning");
  assert.strictEqual(inventory.statusOf(8), "warning");
  assert.strictEqual(inventory.statusOf(7), "critical");
  assert.strictEqual(inventory.statusOf(0), "critical");
  assert.strictEqual(inventory.statusOf(-1), "expired");
  assert.strictEqual(inventory.statusOf(null), "unknown");
});

g("inventory — isDue");
await t("expiry mode fires inside the window only", () => {
  assert.strictEqual(inventory.isDue(app(), cred(60)), false);
  assert.strictEqual(inventory.isDue(app(), cred(20)), true);
  assert.strictEqual(inventory.isDue(app(), cred(-5)), true, "an expired secret is still due");
});
await t("auto_rotate off is never due", () => {
  assert.strictEqual(inventory.isDue(app({ auto_rotate: false }), cred(1)), false);
});
await t("inactive app is never due", () => {
  assert.strictEqual(inventory.isDue(app({ active: false }), cred(1)), false);
});
await t("manual mode is never due", () => {
  assert.strictEqual(inventory.isDue(app({ rotation_mode: "manual" }), cred(1)), false);
});
await t("no credential in expiry mode → not due", () => {
  assert.strictEqual(inventory.isDue(app(), null), false);
});
await t("monthly fires once this month's day has passed", () => {
  const a = app({ rotation_mode: "monthly", monthly_day: 1, last_rotated_at: null });
  assert.strictEqual(inventory.isDue(a, cred(300)), true);
  a.last_rotated_at = new Date().toISOString();
  assert.strictEqual(inventory.isDue(a, cred(300)), false, "already rotated this month");
});
await t("monthly still rotates a secret about to die", () => {
  const a = app({ rotation_mode: "monthly", monthly_day: 28, last_rotated_at: new Date().toISOString() });
  assert.strictEqual(inventory.isDue(a, cred(3)), true);
});

g("inventory — nextRotation");
await t("nothing scheduled when auto-rotate is off", () => {
  assert.strictEqual(inventory.nextRotation(app({ auto_rotate: false }), 10), null);
});
await t("expiry mode points at expiry minus the threshold", () => {
  const iso = inventory.nextRotation(app(), 100);
  const days = Math.round((new Date(iso) - Date.now()) / DAY);
  assert.ok(days >= 69 && days <= 71, "expected ~70 days, got " + days);
});
await t("a date already past clamps to now", () => {
  assert.ok(new Date(inventory.nextRotation(app(), -5)).getTime() <= Date.now() + 2000);
});
await t("monthly gives a day-of-month in the future", () => {
  const iso = inventory.nextRotation(app({ rotation_mode: "monthly", monthly_day: 15 }), 100);
  const d = new Date(iso);
  assert.strictEqual(d.getDate(), 15);
  assert.ok(d.getTime() > Date.now());
});

// ---- Coolify adapter (HTTP stubbed at global fetch) ----

// Records the requests the client makes and answers from `routes`,
// a list of [methodAndPathRegex, responder].
function httpStub(routes) {
  const sent = [];
  const fn = async (url, opts) => {
    const o = opts || {};
    const method = o.method || "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    sent.push({ method, path, url: String(url), headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null });
    for (const [re, respond] of routes) {
      if (re.test(method + " " + path)) return respond(sent[sent.length - 1]);
    }
    return jsonRes({ message: "no stub for " + method + " " + path }, 404);
  };
  fn.sent = sent;
  return fn;
}
const APP = "app-uuid-1";
const ENVS_PATH = "/api/v1/applications/" + APP + "/envs";

g("coolify — reading variables");
await t("values come back as a key→value map", async () => {
  const f = httpStub([[/^GET \/api\/v1\/applications\/.+\/envs$/, () => jsonRes([
    { key: "DATABASE_URL", value: "postgres://x" },
    { key: "SSO_CLIENT_SECRET", value: "OLD" },
  ])]]);
  await withFetch(f, async () => {
    const r = await coolify.listVariables(APP);
    assert.deepStrictEqual(r.vars, { DATABASE_URL: "postgres://x", SSO_CLIENT_SECRET: "OLD" });
    assert.strictEqual(r.values, true);
    assert.strictEqual(f.sent[0].headers.Authorization, "Bearer test-token");
  });
});
await t("real_value is used when value is absent", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "K", value: null, real_value: "resolved" }])]]);
  await withFetch(f, async () => {
    assert.strictEqual((await coolify.listVariables(APP)).vars.K, "resolved");
  });
});
await t("a token without read:sensitive is reported as unreadable", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "A", value: null }, { key: "B", value: null }])]]);
  await withFetch(f, async () => {
    const r = await coolify.listVariables(APP);
    assert.strictEqual(r.values, false, "no value readable → rollback could not snapshot");
    const v = await coolify.getVariable(APP, "A");
    assert.strictEqual(v.exists, true);
    assert.strictEqual(v.readable, false);
  });
});
await t("a variable that does not exist yet is reported, not invented", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "OTHER", value: "x" }])]]);
  await withFetch(f, async () => {
    const v = await coolify.getVariable(APP, "SSO_CLIENT_SECRET");
    assert.strictEqual(v.exists, false);
    assert.strictEqual(v.value, null);
  });
});

g("coolify — writing one variable");
await t("PATCH carries exactly that key and nothing else", async () => {
  const f = httpStub([[/^PATCH .*\/envs$/, () => jsonRes({ key: "SSO_CLIENT_SECRET" }, 201)]]);
  await withFetch(f, async () => {
    const r = await coolify.setVariable(APP, "SSO_CLIENT_SECRET", "NEWVAL");
    assert.strictEqual(r.mode, "patch");
    assert.strictEqual(f.sent.length, 1, "one request, no read-modify-write");
    assert.strictEqual(f.sent[0].method, "PATCH");
    assert.strictEqual(f.sent[0].path, ENVS_PATH);
    assert.deepStrictEqual(f.sent[0].body, { key: "SSO_CLIENT_SECRET", value: "NEWVAL", is_preview: false });
  });
});
await t("a missing key falls back from PATCH to POST", async () => {
  const f = httpStub([
    [/^PATCH .*\/envs$/, () => jsonRes({ message: "Resource not found." }, 404)],
    [/^POST .*\/envs$/, () => jsonRes({ uuid: "env-uuid" }, 201)],
  ]);
  await withFetch(f, async () => {
    const r = await coolify.setVariable(APP, "NEW_KEY", "V");
    assert.strictEqual(r.mode, "create");
    assert.deepStrictEqual(f.sent.map((x) => x.method), ["PATCH", "POST"]);
  });
});
await t("a real error is not mistaken for a missing key", async () => {
  const f = httpStub([[/^PATCH .*\/envs$/, () => jsonRes({ message: "boom" }, 500)]]);
  await withFetch(f, async () => {
    await assert.rejects(() => coolify.setVariable(APP, "K", "V"), /boom/);
    assert.strictEqual(f.sent.length, 1, "must not POST after a 500");
  });
});

g("coolify — restart and errors");
await t("restart posts to the application and returns the deployment", async () => {
  const f = httpStub([[/^POST .*\/restart$/, () => jsonRes({ message: "ok", deployment_uuid: "dep-9" })]]);
  await withFetch(f, async () => {
    assert.strictEqual(await coolify.restartApplication(APP), "dep-9");
    assert.strictEqual(f.sent[0].path, "/api/v1/applications/" + APP + "/restart");
  });
});
await t("401 is reported as a bad token", async () => {
  await withFetch(httpStub([[/./, () => jsonRes({}, 401)]]), async () => {
    await assert.rejects(() => coolify.listApplications(), /rejected the API token/);
  });
});
await t("403 names the permissions the token needs", async () => {
  await withFetch(httpStub([[/./, () => jsonRes({}, 403)]]), async () => {
    await assert.rejects(() => coolify.listApplications(), /read:sensitive, write and deploy/);
  });
});
await t("429 is retried once, honouring Retry-After", async () => {
  let n = 0;
  const f = async () => {
    n++;
    if (n === 1) return Object.assign(jsonRes({}, 429), { headers: { get: () => "0" } });
    return jsonRes([]);
  };
  await withFetch(f, async () => {
    assert.deepStrictEqual(await coolify.listApplications(), []);
    assert.strictEqual(n, 2, "one retry");
  });
});

g("coolify — applications");
await t("applications are listed with their first domain", async () => {
  const f = httpStub([[/^GET \/api\/v1\/applications$/, () => jsonRes([
    { uuid: "u2", name: "Zed", fqdn: "https://z.example,https://www.z.example", status: "running" },
    { uuid: "u1", name: "Alpha", fqdn: "https://a.example", status: "running" },
  ])]]);
  await withFetch(f, async () => {
    const apps = await coolify.listApplications();
    assert.deepStrictEqual(apps.map((a) => a.name), ["Alpha", "Zed"], "sorted by name");
    assert.strictEqual(apps[1].fqdn, "https://z.example", "only the first domain");
  });
});

g("mailer — configuration validation");
await t("recipients split on commas, semicolons and spaces", () => {
  assert.deepStrictEqual(normalise({ sender: "a@b.com", recipients: "x@y.com, z@y.com;  q@y.com" }).recipients,
    ["x@y.com", "z@y.com", "q@y.com"]);
});
await t("thresholds are sorted descending and bounded to 1..365", () => {
  assert.deepStrictEqual(normalise({ sender: "a@b.com", recipients: "x@y.com", thresholds: "7, 400, 30, 0, 1" }).thresholds, [30, 7, 1]);
});
await t("an invalid address is rejected", () => {
  assert.throws(() => normalise({ sender: "a@b.com", recipients: "not-an-email" }), /Not an email address/);
});
await t("empty thresholds fall back to the defaults", () => {
  assert.deepStrictEqual(normalise({ sender: "a@b.com", recipients: "x@y.com", thresholds: "" }).thresholds, mailer.DEFAULTS.thresholds);
});
await t("esc neutralises tags and quotes", () => {
  assert.strictEqual(mailer.esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

console.log("\n" + pass + " checks passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
process.exit(process.exitCode || 0);
})();

// mailer.setConfig writes to the database; this mirrors exactly its
// normalisation rules so they stay covered without one.
function normalise(v) {
  const c = {
    sender: String(v.sender || "").trim().toLowerCase(),
    recipients: String(v.recipients || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
    thresholds: String(v.thresholds === undefined ? "" : v.thresholds).split(/[,;\s]+/)
      .map((n) => parseInt(n, 10)).filter((n) => n > 0 && n <= 365).sort((a, b) => b - a),
  };
  if (!c.thresholds.length) c.thresholds = mailer.DEFAULTS.thresholds;
  const bad = c.recipients.concat(c.sender ? [c.sender] : []).find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw new Error("Not an email address: " + bad);
  return c;
}
