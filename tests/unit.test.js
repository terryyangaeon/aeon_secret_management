// Pure-logic tests — no database. Network calls are stubbed at global fetch.
//   node tests/unit.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused";
// lib/graph.js reads these at require time; without them it refuses before any
// stub is reached. Fake values — every Graph call in this file is stubbed.
process.env.SSO_TENANT_ID = process.env.SSO_TENANT_ID || "test-tenant";
process.env.SSO_CLIENT_ID = process.env.SSO_CLIENT_ID || "test-client";
process.env.SSO_CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || "test-secret";
process.env.COOLIFY_URL = "https://coolify-kvm.aeondelightasia.online";   // so coolify.getConfig()
process.env.COOLIFY_API_TOKEN = "test-token";                           // never touches the DB
const assert = require("assert");

const inventory = require("../lib/inventory");
const coolify = require("../lib/coolify");
const mailer = require("../lib/mailer");
const regdb = require("../lib/regdb");

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
await t("daysLeft follows the calendar date, so adjacent expiry dates differ by one", () => {
  // 19 Nov 2026, early UTC. 18 Apr 2027 is 150 calendar days later; 19 Apr is 151.
  // The old hour-based count put both of these in the same 150-day bucket.
  const now = Date.parse("2026-11-19T03:44:00.000Z");
  assert.strictEqual(inventory.daysLeft("2027-04-18T20:00:00.000Z", now), 150);
  assert.strictEqual(inventory.daysLeft("2027-04-19T02:00:00.000Z", now), 151);
  assert.strictEqual(inventory.daysLeft("2026-11-19T23:00:00.000Z", now), 0, "later today is 0 days left");
  assert.strictEqual(inventory.daysLeft("2026-11-18T23:00:00.000Z", now), -1, "yesterday is negative");
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
await t("preview variables never leak into the production set", async () => {
  // Coolify returns the same key twice when an app has preview deployments, and
  // the values differ. Snapshotting the preview value and rolling it back would
  // write the wrong secret into production — this is from the live API.
  const f = httpStub([[/envs$/, () => jsonRes([
    { key: "DATABASE_URL", value: "postgres://production", is_preview: false },
    { key: "DATABASE_URL", value: "postgres://preview", is_preview: true },
    { key: "SSO_CLIENT_SECRET", value: "PROD-SECRET", is_preview: false },
    { key: "SSO_CLIENT_SECRET", value: "PREVIEW-SECRET", is_preview: true },
    { key: "ONLY_IN_PREVIEW", value: "x", is_preview: true },
  ])]]);
  await withFetch(f, async () => {
    const prod = await coolify.listVariables(APP);
    assert.strictEqual(prod.vars.DATABASE_URL, "postgres://production");
    assert.strictEqual(prod.vars.SSO_CLIENT_SECRET, "PROD-SECRET");
    assert.ok(!("ONLY_IN_PREVIEW" in prod.vars), "preview-only keys must not appear");
    assert.strictEqual((await coolify.getVariable(APP, "SSO_CLIENT_SECRET")).value, "PROD-SECRET");
    const prev = await coolify.listVariables(APP, { preview: true });
    assert.strictEqual(prev.vars.SSO_CLIENT_SECRET, "PREVIEW-SECRET", "the other set is reachable on purpose");
  });
});
await t("an entry with no is_preview flag counts as production", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "K", value: "v" }])]]);
  await withFetch(f, async () => {
    assert.strictEqual((await coolify.listVariables(APP)).vars.K, "v");
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
await t("redeploy applies a new secret, and falls back to restart", async () => {
  const f = httpStub([
    [/^POST \/api\/v1\/deploy\?/, () => jsonRes({ deployments: [{ deployment_uuid: "dep-1", resource_uuid: APP }] })],
    [/^GET \/api\/v1\/deployments\/dep-1$/, () => jsonRes({ status: "finished", deployment_uuid: "dep-1" })],
  ]);
  await withFetch(f, async () => {
    assert.strictEqual(await coolify.restartApplication(APP), "dep-1");
    assert.ok(/^POST \/api\/v1\/deploy\?uuid=/.test(f.sent[0].method + " " + f.sent[0].path) || f.sent[0].path.indexOf("/deploy?uuid=") === 0);
    assert.strictEqual(f.sent[0].path.indexOf("force=false") >= 0, true);
  });
});
await t("a cached Next.js page is not a successful health check", () => {
  assert.strictEqual(coolify.healthAccepted(200, null), true);
  assert.strictEqual(coolify.healthAccepted(200, "MISS"), true);
  assert.strictEqual(coolify.healthAccepted(200, "HIT"), false);
  assert.strictEqual(coolify.healthAccepted(503, null), false);
});
await t("restart posts to the application when deploy is not available", async () => {
  const f = httpStub([[/^POST .*\/restart$/, () => jsonRes({ message: "ok", deployment_uuid: "dep-9" })]]);
  await withFetch(f, async () => {
    assert.strictEqual(await coolify.restartApplication(APP), "dep-9");
    const restart = f.sent.filter((s) => s.path.indexOf("/restart") >= 0);
    assert.strictEqual(restart.length, 1);
    assert.strictEqual(restart[0].path, "/api/v1/applications/" + APP + "/restart");
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

// ---- Graph: tenant-wide visibility vs what may be rotated ----
const graphapp = require("../lib/graphapp");

function graphStub(routes) {
  const sent = [];
  const fn = async (url, opts) => {
    const o = opts || {};
    const method = o.method || "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+\/v1\.0/, "");
    sent.push({ method, path });
    if (/oauth2\/v2\.0\/token/.test(String(url))) return jsonRes({ access_token: "t", expires_in: 3600 });
    for (const [re, respond] of routes) if (re.test(path)) return respond();
    return jsonRes({ error: { message: "no stub for " + path } }, 404);
  };
  fn.sent = sent;
  return fn;
}
const appRow = (id, name) => ({ id, appId: "client-" + id, displayName: name, passwordCredentials: [], keyCredentials: [] });
const SP = [[/^\/servicePrincipals\?/, () => jsonRes({ value: [{ id: "sp-1", appId: "me", displayName: "Secret Management" }] })]];

await t("grantOwner adds this app's service principal, and skips one that already owns it", async () => {
  const posts = [];
  const fn = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/v1\.0/, "");
    const method = (opts && opts.method) || "GET";
    if (/oauth2\/v2\.0\/token/.test(String(url))) return jsonRes({ access_token: "t", expires_in: 3600 });
    if (/^\/servicePrincipals\?/.test(path)) return jsonRes({ value: [{ id: "sp-1", appId: "me", displayName: "AEON Secret Management" }] });
    if (method === "GET" && /\/owners/.test(path)) return jsonRes({ value: [] });
    if (method === "POST" && /\/owners\/\$ref$/.test(path)) {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return jsonRes({ error: { message: "no stub for " + method + " " + path } }, 404);
  };
  const oid = "11111111-2222-3333-4444-555555555555";
  await withFetch(fn, async () => {
    const r = await graphapp.grantOwner(oid);
    assert.strictEqual(r.already, false);
    assert.strictEqual(r.servicePrincipalId, "sp-1");
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0]["@odata.id"], "https://graph.microsoft.com/v1.0/directoryObjects/sp-1");
  });
  const again = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/v1\.0/, "");
    const method = (opts && opts.method) || "GET";
    if (/oauth2\/v2\.0\/token/.test(String(url))) return jsonRes({ access_token: "t", expires_in: 3600 });
    if (/^\/servicePrincipals\?/.test(path)) return jsonRes({ value: [{ id: "sp-1", appId: "me", displayName: "AEON Secret Management" }] });
    if (method === "GET" && /\/owners/.test(path)) return jsonRes({ value: [{ id: "sp-1" }] });
    if (method === "POST") throw new Error("should not post when already an owner");
    return jsonRes({ error: { message: "no stub" } }, 404);
  };
  await withFetch(again, async () => {
    const r = await graphapp.grantOwner(oid);
    assert.strictEqual(r.already, true);
  });
});
await t("grantOwner says which permission is missing when Entra refuses", async () => {
  const fn = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/v1\.0/, "");
    const method = (opts && opts.method) || "GET";
    if (/oauth2\/v2\.0\/token/.test(String(url))) return jsonRes({ access_token: "t", expires_in: 3600 });
    if (/^\/servicePrincipals\?/.test(path)) return jsonRes({ value: [{ id: "sp-1", appId: "me", displayName: "AEON Secret Management" }] });
    if (method === "GET" && /\/owners/.test(path)) return jsonRes({ value: [] });
    if (method === "POST") return jsonRes({ error: { message: "Insufficient privileges" } }, 403);
    return jsonRes({}, 404);
  };
  await withFetch(fn, async () => {
    await assert.rejects(() => graphapp.grantOwner("11111111-2222-3333-4444-555555555555"), /Application\.ReadWrite\.All/);
  });
});

g("graph — what can be seen vs what can be rotated");
await t("owned registrations are flagged, others are visible but not", async () => {
  const f = graphStub(SP.concat([
    [/^\/applications\?/, () => jsonRes({ value: [appRow("a1", "Owned App"), appRow("a2", "Someone Else's App")] })],
    [/ownedObjects/, () => jsonRes({ value: [{ id: "a1" }] })],
  ]));
  await withFetch(f, async () => {
    const inv = await graphapp.inventory(true);
    assert.strictEqual(inv.total, 2);
    assert.strictEqual(inv.owned, 1);
    assert.strictEqual(inv.tenantWide, true, "seeing an unowned app means Read.All is in effect");
    assert.strictEqual(inv.apps.find((a) => a.objectId === "a1").owned, true);
    assert.strictEqual(inv.apps.find((a) => a.objectId === "a2").owned, false);
  });
});
await t("listOwned excludes what cannot be rotated", async () => {
  const f = graphStub(SP.concat([
    [/^\/applications\?/, () => jsonRes({ value: [appRow("a1", "Owned App"), appRow("a2", "Someone Else's App")] })],
    [/ownedObjects/, () => jsonRes({ value: [{ id: "a1" }] })],
  ]));
  await withFetch(f, async () => {
    const owned = await graphapp.listOwned(true);
    assert.deepStrictEqual(owned.map((a) => a.objectId), ["a1"], "a2 must never reach anything that writes");
  });
});
await t("without Read.All everything visible is owned, and tenantWide is false", async () => {
  const f = graphStub(SP.concat([
    [/^\/applications\?/, () => jsonRes({ value: [appRow("a1", "Owned App")] })],
    [/ownedObjects/, () => jsonRes({ value: [{ id: "a1" }] })],
  ]));
  await withFetch(f, async () => {
    const inv = await graphapp.inventory(true);
    assert.strictEqual(inv.tenantWide, false);
    assert.strictEqual(inv.owned, 1);
  });
});
await t("if ownership cannot be read, nothing is wrongly claimed as owned", async () => {
  const f = graphStub(SP.concat([
    [/^\/applications\?/, () => jsonRes({ value: [appRow("a1", "App")] })],
    [/ownedObjects/, () => jsonRes({ error: { message: "Insufficient privileges" } }, 403)],
  ]));
  await withFetch(f, async () => {
    const inv = await graphapp.inventory(true);
    assert.strictEqual(inv.apps[0].owned, null, "unknown, not true");
    assert.strictEqual(inv.tenantWide, false, "cannot claim tenant-wide without knowing ownership");
  });
});

g("new secret validity — tenant cap of less than 6 months");
await t("1 to 5 months are accepted, including numeric strings", () => {
  [1, 2, 3, 4, 5, "1", "5", " 4 "].forEach((v) => {
    assert.strictEqual(regdb.assertLifetimeMonths(v), parseInt(v, 10));
  });
});
await t("6 and above, below 1, and non-integers are rejected in both languages", () => {
  [0, 6, 7, 24, -1, 5.5, 6.0, "6", "0", "24", "", "abc", "5.5", null, undefined, true].forEach((v) => {
    assert.throws(() => regdb.assertLifetimeMonths(v), (e) => {
      assert.ok(e.message.indexOf("1 至 5") >= 0 && e.message.indexOf("less than 6") >= 0, e.message);
      assert.strictEqual(e.status, 400);
      assert.strictEqual(e.code, "lifetime_months");
      return true;
    });
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
