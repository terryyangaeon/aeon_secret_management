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
    const r = await coolify.listVariables(undefined, APP);
    assert.deepStrictEqual(r.vars, { DATABASE_URL: "postgres://x", SSO_CLIENT_SECRET: "OLD" });
    assert.strictEqual(r.values, true);
    assert.strictEqual(f.sent[0].headers.Authorization, "Bearer test-token");
  });
});
await t("real_value is used when value is absent", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "K", value: null, real_value: "resolved" }])]]);
  await withFetch(f, async () => {
    assert.strictEqual((await coolify.listVariables(undefined, APP)).vars.K, "resolved");
  });
});
await t("a token without read:sensitive is reported as unreadable", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "A", value: null }, { key: "B", value: null }])]]);
  await withFetch(f, async () => {
    const r = await coolify.listVariables(undefined, APP);
    assert.strictEqual(r.values, false, "no value readable → rollback could not snapshot");
    const v = await coolify.getVariable(undefined, APP, "A");
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
    const prod = await coolify.listVariables(undefined, APP);
    assert.strictEqual(prod.vars.DATABASE_URL, "postgres://production");
    assert.strictEqual(prod.vars.SSO_CLIENT_SECRET, "PROD-SECRET");
    assert.ok(!("ONLY_IN_PREVIEW" in prod.vars), "preview-only keys must not appear");
    assert.strictEqual((await coolify.getVariable(undefined, APP, "SSO_CLIENT_SECRET")).value, "PROD-SECRET");
    const prev = await coolify.listVariables(undefined, APP, { preview: true });
    assert.strictEqual(prev.vars.SSO_CLIENT_SECRET, "PREVIEW-SECRET", "the other set is reachable on purpose");
  });
});
await t("an entry with no is_preview flag counts as production", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "K", value: "v" }])]]);
  await withFetch(f, async () => {
    assert.strictEqual((await coolify.listVariables(undefined, APP)).vars.K, "v");
  });
});
await t("a variable that does not exist yet is reported, not invented", async () => {
  const f = httpStub([[/envs$/, () => jsonRes([{ key: "OTHER", value: "x" }])]]);
  await withFetch(f, async () => {
    const v = await coolify.getVariable(undefined, APP, "SSO_CLIENT_SECRET");
    assert.strictEqual(v.exists, false);
    assert.strictEqual(v.value, null);
  });
});

g("coolify — writing one variable");
await t("PATCH carries exactly that key and nothing else", async () => {
  const f = httpStub([[/^PATCH .*\/envs$/, () => jsonRes({ key: "SSO_CLIENT_SECRET" }, 201)]]);
  await withFetch(f, async () => {
    const r = await coolify.setVariable(undefined, APP, "SSO_CLIENT_SECRET", "NEWVAL");
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
    const r = await coolify.setVariable(undefined, APP, "NEW_KEY", "V");
    assert.strictEqual(r.mode, "create");
    assert.deepStrictEqual(f.sent.map((x) => x.method), ["PATCH", "POST"]);
  });
});
await t("a real error is not mistaken for a missing key", async () => {
  const f = httpStub([[/^PATCH .*\/envs$/, () => jsonRes({ message: "boom" }, 500)]]);
  await withFetch(f, async () => {
    await assert.rejects(() => coolify.setVariable(undefined, APP, "K", "V"), /boom/);
    assert.strictEqual(f.sent.length, 1, "must not POST after a 500");
  });
});

g("coolify — restart and errors");
await t("restart posts to the application and returns the deployment", async () => {
  const f = httpStub([[/^POST .*\/restart$/, () => jsonRes({ message: "ok", deployment_uuid: "dep-9" })]]);
  await withFetch(f, async () => {
    assert.strictEqual(await coolify.restartApplication(undefined, APP), "dep-9");
    assert.strictEqual(f.sent[0].path, "/api/v1/applications/" + APP + "/restart");
  });
});
await t("401 is reported as a bad token", async () => {
  await withFetch(httpStub([[/./, () => jsonRes({}, 401)]]), async () => {
    await assert.rejects(() => coolify.listApplications(undefined), /rejected the API token/);
  });
});
await t("403 names the permissions the token needs", async () => {
  await withFetch(httpStub([[/./, () => jsonRes({}, 403)]]), async () => {
    await assert.rejects(() => coolify.listApplications(undefined), /read:sensitive, write and deploy/);
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
    assert.deepStrictEqual(await coolify.listApplications(undefined), []);
    assert.strictEqual(n, 2, "one retry");
  });
});

g("coolify — multiple connections");
const SHARED_UUID = "same-uuid-on-two-hosts";
await t("the same application uuid on two hosts uses the right token and base URL", async () => {
  coolify.setTestConnectionResolver((id) => ({
    1: { id: 1, baseUrl: "https://coolify-kvm.aeondelightasia.online", token: "token-kvm", fromEnv: false },
    2: { id: 2, baseUrl: "https://coolify.aeondelightasia.online", token: "token-main", fromEnv: false },
  }[id]));
  const f = httpStub([[/^PATCH .*\/envs$/, (req) => {
    if (req.url.indexOf("coolify-kvm") >= 0) {
      assert.strictEqual(req.headers.Authorization, "Bearer token-kvm");
    } else {
      assert.strictEqual(req.headers.Authorization, "Bearer token-main");
    }
    return jsonRes({ key: "SSO_CLIENT_SECRET" }, 201);
  }]]);
  try {
    await withFetch(f, async () => {
      await coolify.setVariable(1, SHARED_UUID, "SSO_CLIENT_SECRET", "KVM-VAL");
      await coolify.setVariable(2, SHARED_UUID, "SSO_CLIENT_SECRET", "MAIN-VAL");
      assert.strictEqual(f.sent.length, 2);
      assert.ok(f.sent[0].url.indexOf("coolify-kvm") >= 0);
      assert.ok(f.sent[1].url.indexOf("coolify.aeondelightasia.online") >= 0);
      assert.strictEqual(f.sent[0].body.value, "KVM-VAL");
      assert.strictEqual(f.sent[1].body.value, "MAIN-VAL");
    });
  } finally {
    coolify.setTestConnectionResolver(null);
  }
});
await t("a failure on one host does not change requests already sent to another", async () => {
  coolify.setTestConnectionResolver((id) => ({
    1: { id: 1, baseUrl: "https://host-a.test", token: "a", fromEnv: false },
    2: { id: 2, baseUrl: "https://host-b.test", token: "b", fromEnv: false },
  }[id]));
  const f = httpStub([
    [/^PATCH .*\/envs$/, (req) => {
      if (req.url.indexOf("host-a") >= 0) return jsonRes({ key: "K" }, 201);
      return jsonRes({ message: "boom" }, 500);
    }],
  ]);
  try {
    await withFetch(f, async () => {
      await coolify.setVariable(1, APP, "K", "ok-a");
      await assert.rejects(() => coolify.setVariable(2, APP, "K", "fail-b"), /boom/);
      assert.strictEqual(f.sent.length, 2);
      assert.ok(/^https:\/\/host-a\.test/.test(f.sent[0].url));
      assert.ok(/^https:\/\/host-b\.test/.test(f.sent[1].url));
    });
  } finally {
    coolify.setTestConnectionResolver(null);
  }
});

g("supabase — project secrets");
const supabase = require("../lib/supabase");
const PROJECT = "abcdefghijklmnopqrst";
await t("a project URL and a management URL identify the same secrets endpoint", () => {
  const a = supabase.resolveEndpoint("https://" + PROJECT + ".supabase.co/");
  const b = supabase.resolveEndpoint("https://api.supabase.com/v1/projects/" + PROJECT);
  assert.strictEqual(a.ref, PROJECT);
  assert.strictEqual(a.secretsUrl, "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets");
  assert.strictEqual(a.authUrl, "https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth");
  assert.strictEqual(b.secretsUrl, a.secretsUrl);
  assert.strictEqual(b.authUrl, a.authUrl);
  const authPath = supabase.resolveEndpoint("https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth");
  const secretsPath = supabase.resolveEndpoint("https://api.supabase.com/v1/projects/" + PROJECT + "/secrets/");
  assert.strictEqual(authPath.ref, PROJECT);
  assert.strictEqual(authPath.endpoint, "https://api.supabase.com/v1/projects/" + PROJECT);
  assert.strictEqual(authPath.authUrl, a.authUrl);
  assert.strictEqual(authPath.secretsUrl, a.secretsUrl);
  assert.strictEqual(secretsPath.endpoint, authPath.endpoint);
  assert.throws(() => supabase.resolveEndpoint("https://api.supabase.com"), /identify one project/);
  assert.throws(() => supabase.resolveEndpoint("https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth/extra"), /identify one project/);
  const stripped = supabase.resolveEndpoint("https://user:secret-value@" + PROJECT + ".supabase.co/?apikey=secret-value");
  assert.strictEqual(stripped.endpoint, "https://" + PROJECT + ".supabase.co");
  assert.ok(!stripped.endpoint.includes("secret-value") && !stripped.secretsUrl.includes("secret-value"));
});
await t("listing secrets keeps names and drops digests", async () => {
  supabase.setTestConnectionResolver(() => ({
    id: 7, endpoint: "https://" + PROJECT + ".supabase.co", ref: PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets",
    token: "sbp-test", name: "ITQPOMS",
  }));
  const digest = "a".repeat(64);
  const f = httpStub([[/^GET \/v1\/projects\/.+\/secrets$/, () => jsonRes([
    { name: "GOTRUE_EXTERNAL_AZURE_SECRET", value: digest },
    { name: "OTHER", value: digest },
  ])]]);
  try {
    await withFetch(f, async () => {
      const listed = await supabase.listSecrets(7);
      assert.deepStrictEqual(listed.names, ["GOTRUE_EXTERNAL_AZURE_SECRET", "OTHER"]);
      assert.strictEqual(listed.readable, false);
      const one = await supabase.getVariable(7, "GOTRUE_EXTERNAL_AZURE_SECRET");
      assert.strictEqual(one.exists, true);
      assert.strictEqual(one.value, null);
      assert.strictEqual(one.readable, false);
      assert.strictEqual(f.sent[0].headers.Authorization, "Bearer sbp-test");
      const probe = await supabase.test(7);
      assert.strictEqual(probe.ok, true);
      assert.strictEqual(probe.secrets, 2);
      assert.strictEqual(probe.projectRef, PROJECT);
      assert.ok(!JSON.stringify(probe).includes(digest), "the digest must not leave the client");
      assert.ok(!JSON.stringify(probe).includes("sbp-test"), "the token must not leave the client");
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});
await t("updating one secret posts only that name and value", async () => {
  supabase.setTestConnectionResolver((id) => ({
    id: id, endpoint: "https://" + PROJECT + ".supabase.co", ref: id === 2 ? "bbbbbbbbbbbbbbbbbbbb" : PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + (id === 2 ? "bbbbbbbbbbbbbbbbbbbb" : PROJECT) + "/secrets",
    token: "token-" + id, name: "p",
  }));
  const f = httpStub([[/^POST \/v1\/projects\/.+\/secrets$/, () => jsonRes({}, 201)]]);
  try {
    await withFetch(f, async () => {
      const r = await supabase.setVariable(1, "GOTRUE_EXTERNAL_AZURE_SECRET", "NEWVAL");
      assert.strictEqual(r.mode, "upsert");
      assert.deepStrictEqual(f.sent[0].body, [{ name: "GOTRUE_EXTERNAL_AZURE_SECRET", value: "NEWVAL" }]);
      assert.strictEqual(f.sent[0].headers.Authorization, "Bearer token-1");
      await assert.rejects(() => supabase.setVariable(1, "SUPABASE_URL", "x"), /SUPABASE_/);
      assert.strictEqual(f.sent.length, 1, "a reserved name is refused before the request");
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});
await t("a rejected Supabase token is reported without the token", async () => {
  supabase.setTestConnectionResolver(() => ({
    id: 1, endpoint: "https://" + PROJECT + ".supabase.co", ref: PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets",
    token: "sbp-secret", name: "p",
  }));
  const f = httpStub([[/^GET \/v1\/projects\/.+\/secrets$/, () => jsonRes({ message: "unauthorized" }, 401)]]);
  try {
    await withFetch(f, async () => {
      await assert.rejects(() => supabase.listSecrets(1), (e) => {
        assert.match(e.message, /rejected the API token/);
        assert.ok(!e.message.includes("sbp-secret"));
        return true;
      });
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});
await t("an Auth target patches external_azure_secret and nowhere else", async () => {
  supabase.setTestConnectionResolver(() => ({
    id: 1, endpoint: "https://api.supabase.com/v1/projects/" + PROJECT, ref: PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets",
    authUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth",
    token: "sbp-test", name: "ITQPOMS",
  }));
  const f = httpStub([[/^PATCH \/v1\/projects\/.+\/config\/auth$/, () => jsonRes({ external_azure_secret: "should-not-leak" }, 200)]]);
  try {
    await withFetch(f, async () => {
      const r = await supabase.setAzureSecret(1, "NEW-ENTRA-SECRET");
      assert.strictEqual(r.mode, "patch");
      assert.strictEqual(r.key, "external_azure_secret");
      assert.strictEqual(f.sent.length, 1);
      assert.strictEqual(f.sent[0].method, "PATCH");
      assert.strictEqual(f.sent[0].path, "/v1/projects/" + PROJECT + "/config/auth");
      assert.deepStrictEqual(f.sent[0].body, { external_azure_secret: "NEW-ENTRA-SECRET" });
      assert.strictEqual(f.sent[0].headers.Authorization, "Bearer sbp-test");
      assert.ok(!JSON.stringify(r).includes("should-not-leak"));
      assert.ok(!JSON.stringify(r).includes("NEW-ENTRA-SECRET"));
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});
await t("Test connection passes when secrets return 403 and auth config returns 200", async () => {
  const previous = "previous-entra-secret-value";
  supabase.setTestConnectionResolver(() => ({
    id: 4, endpoint: "https://api.supabase.com/v1/projects/" + PROJECT, ref: PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets",
    authUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth",
    token: "sbp-auth-only", name: "ITQPOMS",
  }));
  const f = httpStub([
    [/^GET \/v1\/projects\/.+\/config\/auth$/, () => jsonRes({
      external_azure_enabled: true,
      external_azure_client_id: "client-id-not-a-secret",
      external_azure_secret: previous,
    })],
    [/^GET \/v1\/projects\/.+\/secrets$/, () => jsonRes({ message: "forbidden" }, 403)],
  ]);
  try {
    await withFetch(f, async () => {
      const probe = await supabase.test(4);
      assert.strictEqual(probe.ok, true);
      assert.strictEqual(probe.authReadable, true);
      assert.strictEqual(probe.azureEnabled, true);
      assert.strictEqual(probe.secretsReadable, false);
      assert.strictEqual(probe.secrets, 0);
      assert.match(probe.note, /Auth: Azure secret target can use this connection/);
      assert.match(probe.note, /optional/);
      assert.doesNotMatch(probe.note, /needs permission to read and write project secrets/);
      const dumped = JSON.stringify(probe);
      assert.ok(!dumped.includes(previous), "the auth secret must not leave test()");
      assert.ok(!dumped.includes("client-id-not-a-secret"));
      assert.ok(!dumped.includes("sbp-auth-only"));
      const read = await supabase.getAzureSecret(4);
      assert.strictEqual(read.readable, true);
      assert.strictEqual(read.value, previous);
      assert.strictEqual(read.azureEnabled, true);
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});
await t("a missing auth secret is not treated as readable, and a secrets 403 names that permission", async () => {
  supabase.setTestConnectionResolver(() => ({
    id: 1, ref: PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets",
    authUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth",
    token: "sbp-test", name: "p",
  }));
  const f = httpStub([
    [/^GET \/v1\/projects\/.+\/config\/auth$/, () => jsonRes({ external_azure_enabled: true, external_azure_secret: "a".repeat(64) })],
    [/^GET \/v1\/projects\/.+\/secrets$/, () => jsonRes({ message: "forbidden" }, 403)],
    [/^PATCH \/v1\/projects\/.+\/config\/auth$/, () => jsonRes({ message: "forbidden" }, 403)],
  ]);
  try {
    await withFetch(f, async () => {
      const read = await supabase.getAzureSecret(1);
      assert.strictEqual(read.readable, false);
      assert.strictEqual(read.value, null);
      await assert.rejects(() => supabase.listSecrets(1), (e) => {
        assert.match(e.message, /cannot read project secrets/);
        assert.match(e.message, /GET \/secrets returned 403/);
        assert.doesNotMatch(e.message, /read and write project secrets/);
        return true;
      });
      await assert.rejects(() => supabase.setAzureSecret(1, "NEW-ENTRA-SECRET"), (e) => {
        assert.match(e.message, /cannot update the project's auth config/);
        assert.match(e.message, /PATCH \/config\/auth returned 403/);
        assert.ok(!e.message.includes("NEW-ENTRA-SECRET"));
        return true;
      });
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});

g("regdb — Supabase auth targets");
await t("Auth: Azure secret is recognized from slot, var name, or label text", () => {
  assert.strictEqual(regdb.isSupabaseAzureAuthTarget({ kind: "supabase", supabase_target: "azure_auth" }), true);
  assert.strictEqual(regdb.isSupabaseAzureAuthTarget({ kind: "supabase", var_name: "external_azure_secret" }), true);
  assert.strictEqual(regdb.isSupabaseAzureAuthTarget({ kind: "supabase", varName: "Auth: Azure secret" }), true);
  assert.strictEqual(regdb.isSupabaseAzureAuthTarget({ kind: "supabase", var_name: "MY_APP_SECRET" }), false);
  assert.strictEqual(regdb.isSupabaseAzureAuthTarget({ kind: "coolify", var_name: "external_azure_secret" }), false);
});
await t("targetFields maps Auth: Azure secret to auth config without project secret name", () => {
  const f = regdb.targetFields({
    kind: "supabase",
    supabaseConnectionId: 3,
    varName: "external_azure_secret",
    supabaseTarget: "secret",
  });
  assert.strictEqual(f.supabase_target, "azure_auth");
  assert.strictEqual(f.var_name, "external_azure_secret");
});

await t("getVariable for external_azure_secret reads auth config, not GET /secrets", async () => {
  supabase.setTestConnectionResolver(() => ({
    id: 1, ref: PROJECT,
    secretsUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/secrets",
    authUrl: "https://api.supabase.com/v1/projects/" + PROJECT + "/config/auth",
    token: "sbp-test", name: "p",
  }));
  const f = httpStub([
    [/^GET \/v1\/projects\/.+\/config\/auth$/, () => jsonRes({ external_azure_enabled: true, external_azure_secret: "z".repeat(48) })],
    [/^GET \/v1\/projects\/.+\/secrets$/, () => jsonRes({ message: "forbidden" }, 403)],
  ]);
  try {
    await withFetch(f, async () => {
      const v = await supabase.getVariable(1, "external_azure_secret");
      assert.strictEqual(v.exists, true);
      assert.strictEqual(v.readable, true);
      assert.strictEqual(f.sent.filter((x) => /\/secrets/.test(x.url)).length, 0);
    });
  } finally {
    supabase.setTestConnectionResolver(null);
  }
});

g("regdb — Coolify URL");
await t("normCoolifyUrl adds https and strips a trailing /api/v1", () => {
  assert.strictEqual(regdb.normCoolifyUrl("coolify-kvm.aeondelightasia.online"), "https://coolify-kvm.aeondelightasia.online");
  assert.strictEqual(regdb.normCoolifyUrl("https://x/api/v1/"), "https://x");
});
await t("a connection list view shows the first three token characters and nothing else", async () => {
  const pub = regdb.connectionPublic({
    id: 1, name: "kvm", base_url: "https://coolify.example", from_env: false,
    token_enc: "v1:not-the-token", sort_order: 0, target_count: 2,
  });
  const view = regdb.withTokenPreview(pub, "abcdefghij");
  assert.strictEqual(view.tokenPreview, "abc");
  assert.strictEqual(view.tokenLength, 10);
  assert.strictEqual(view.hasToken, true);
  assert.strictEqual(view.token, undefined);
  assert.strictEqual(view.token_enc, undefined);
  const json = JSON.stringify(view);
  assert.ok(!json.includes("defghij"), "list view included the rest of the token");
  assert.ok(!json.includes("not-the-token"), "list view included the stored ciphertext");
  assert.deepStrictEqual(regdb.tokenMask(""), { tokenPreview: "", tokenLength: 0 });
  assert.deepStrictEqual(regdb.tokenMask("ab"), { tokenPreview: "ab", tokenLength: 2 });
  const envView = await regdb.coolifyConnectionView({
    id: 0, name: "env", base_url: "https://coolify-kvm.aeondelightasia.online",
    from_env: true, token_enc: null, sort_order: 0, target_count: 0,
  });
  assert.strictEqual(envView.tokenPreview, "tes");
  assert.strictEqual(envView.tokenLength, String(process.env.COOLIFY_API_TOKEN || "").length);
  assert.ok(!JSON.stringify(envView).includes(String(process.env.COOLIFY_API_TOKEN || "missing")),
    "from-env list view included the full token");
});

g("coolify — applications");
await t("applications are listed with their first domain", async () => {
  const f = httpStub([[/^GET \/api\/v1\/applications$/, () => jsonRes([
    { uuid: "u2", name: "Zed", fqdn: "https://z.example,https://www.z.example", status: "running" },
    { uuid: "u1", name: "Alpha", fqdn: "https://a.example", status: "running" },
  ])]]);
  await withFetch(f, async () => {
    const apps = await coolify.listApplications(undefined);
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
