// Every /api/… path the pages ask for must exist in server.js.
//
// This exists because the first build of server.js shipped without the
// /api/accounts routes: Account Management rendered its title and nothing else,
// because the page hides its table until the fetch succeeds and a 404 isn't the
// 403 it watches for. A missing route is invisible until someone opens the page.
//
//   node tests/routes.test.js        (no database, no network)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

// ---- What the server serves -------------------------------------------------

const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const routes = [];
const routeRe = /app\.(get|post|put|delete)\(\s*"(\/api\/[^"]*)"/g;
for (let m; (m = routeRe.exec(server));) routes.push({ method: m[1].toUpperCase(), path: m[2] });

// "/api/apps/:id/rotate" → /^\/api\/apps\/[^/]+\/rotate$/
const rx = (p) => new RegExp("^" + p.split("/").map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\/") + "$");
// The literal head of a route, for matching a path the page builds by concatenation.
const head = (p) => p.split("/:")[0];

// ---- What the front end asks for -------------------------------------------

const files = []
  .concat(fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.endsWith(".html")).map((f) => "public/" + f))
  .concat(fs.readdirSync(path.join(ROOT, "public/static")).filter((f) => f.endsWith(".js")).map((f) => "public/static/" + f))
  .concat(["partials/navbar.html"]);

const calls = [];
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

  // api("GET", "/api/apps") — method is explicit
  const apiRe = /api\(\s*"([A-Z]+)"\s*,\s*"(\/api\/[^"]*)"/g;
  for (let m; (m = apiRe.exec(src));) calls.push({ file: rel, method: m[1], path: m[2] });

  // fetch("/api/auth/login", { method: "POST" … }) — look ahead for the method
  const fetchRe = /fetch\(\s*"(\/api\/[^"]*)"\s*(,[\s\S]{0,220})?/g;
  for (let m; (m = fetchRe.exec(src));) {
    const opt = m[2] || "";
    const mm = /method\s*:\s*"([A-Z]+)"/.exec(opt);
    calls.push({ file: rel, method: mm ? mm[1] : "GET", path: m[1] });
  }

  // data-me-url="/api/auth/me" on the navbar — any method will do
  const attrRe = /data-(?:me|logout|login)-url="(\/api\/[^"]*)"/g;
  for (let m; (m = attrRe.exec(src));) calls.push({ file: rel, method: "*", path: m[1] });
}

function resolves(call) {
  const p = call.path.split("?")[0];
  return routes.some((r) => {
    if (call.method !== "*" && r.method !== call.method) return false;
    if (rx(r.path).test(p.replace(/\/$/, ""))) return true;
    // The page builds the rest by concatenation, e.g. "/api/apps/" + id + "/rotate".
    return p.endsWith("/") && head(r.path).replace(/\/$/, "") === p.replace(/\/$/, "");
  });
}

console.log("\nserver routes vs. what the pages call");
t("server.js registers the routes we expect to find", () => {
  assert.ok(routes.length >= 30, "only found " + routes.length + " routes");
});
t("the pages make API calls this test can see", () => {
  assert.ok(calls.length >= 25, "only found " + calls.length + " calls — has the extractor gone stale?");
});
t("every front-end API call resolves to a route", () => {
  const missing = calls.filter((c) => !resolves(c));
  assert.strictEqual(missing.length, 0,
    "no route for:\n       " + missing.map((c) => c.method + " " + c.path + "   (" + c.file + ")").join("\n       "));
});

// The pages Account Management and the navbar depend on, spelled out, because
// these are the ones whose absence shows up as a silently blank page.
const MUST_HAVE = [
  ["GET", "/api/health"], ["GET", "/api/auth/options"], ["POST", "/api/auth/login"],
  ["GET", "/api/auth/me"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/change-password"],
  ["GET", "/api/auth/sso/start"], ["GET", "/api/auth/sso/callback"], ["POST", "/api/auth/sso/redeem"],
  ["GET", "/api/accounts"], ["POST", "/api/accounts"], ["PUT", "/api/accounts/:email"], ["DELETE", "/api/accounts/:email"],
  ["GET", "/api/apps"], ["GET", "/api/apps/:id"], ["POST", "/api/apps/:id/rotate"], ["GET", "/api/runs"],
  ["GET", "/api/config/status"], ["GET", "/api/config/discover"],
  ["GET", "/api/config/apps"], ["POST", "/api/config/apps"], ["PUT", "/api/config/apps/:id"], ["DELETE", "/api/config/apps/:id"],
  ["GET", "/api/config/coolify/test"], ["GET", "/api/config/alerts"], ["PUT", "/api/config/alerts"],
];
t("the OneView contract routes are all present", () => {
  const missing = MUST_HAVE.filter(([m, p]) => !routes.some((r) => r.method === m && r.path === p));
  assert.strictEqual(missing.length, 0, "missing: " + missing.map((x) => x.join(" ")).join(", "));
});

const configHtml = fs.readFileSync(path.join(ROOT, "public/config.html"), "utf8");
const regdbSrc = fs.readFileSync(path.join(ROOT, "lib/regdb.js"), "utf8");
t("the edit-application label is the short new-secret validity wording", () => {
  assert.ok(configHtml.includes("新密碼有效期 New Secret Validity (months &lt;6)"),
    "label text missing");
  assert.ok(!configHtml.includes("New secret lifetime"), "old lifetime label still present");
  assert.ok(!configHtml.includes("the tenant caps this at 6"), "old cap hint still present");
});
t("Save checks new secret validity in the page before calling the API", () => {
  const saveAt = configHtml.indexOf('$("#amSave").addEventListener');
  const checkAt = configHtml.indexOf("validLifetimeMonths", saveAt);
  const apiAt = configHtml.indexOf('api("PUT"', saveAt);
  assert.ok(saveAt > 0 && checkAt > saveAt && apiAt > checkAt, "validity check must run before the save request");
  const err = /var LIFETIME_ERR = "([^"]+)"/.exec(configHtml);
  const serverErr = /const LIFETIME_MONTHS_ERROR =\s*\n\s*"([^"]+)" \+\s*\n\s*"([^"]+)"/.exec(regdbSrc);
  assert.ok(err && serverErr, "could not find the shared error sentence");
  assert.strictEqual(err[1], serverErr[1] + serverErr[2]);
});
t("copying a connection token is admin-only and the audit entry has no token", () => {
  function slice(start, end) {
    const i = server.indexOf(start);
    const j = server.indexOf(end, i + start.length);
    assert.ok(i > 0 && j > i, "could not find " + start);
    return server.slice(i, j);
  }
  const checks = [
    ['app.get("/api/config/coolify/connections/:id/token"', 'app.post("/api/config/coolify"', "coolify.connection.token.copy"],
    ['app.get("/api/config/supabase/connections/:id/token"', 'app.get("/api/config/supabase/variables"', "supabase.connection.token.copy"],
  ];
  checks.forEach(([start, end, action]) => {
    const body = slice(start, end);
    assert.ok(body.includes("requireConfig"), start + " is not admin-only");
    const viewAction = action.replace(".copy", ".view");
    const audit = body.match(/regdb\.audit\(([^)]*)\)/);
    assert.ok(audit, "no audit call in " + start);
    assert.ok(audit[1].includes('"' + action + '"'), "copy audit action missing");
    assert.ok(audit[1].includes('"' + viewAction + '"'), "view audit action missing");
    assert.ok(body.includes('=== "view"'), "view must be chosen only by event=view");
    assert.ok(!body.includes("req.query.event +"), "do not build the audit action from the query");
    assert.ok(/\{\s*id\s*\}\s*$/.test(audit[1]), "audit detail must be the connection id only");
    const rest = audit[1].replace(action, "").replace(viewAction, "");
    assert.ok(!rest.includes("token"), "audit arguments must not include the token");
    assert.ok(!body.includes("console.log"), "token handler must not log");
    assert.ok(!body.includes("token_enc"), "token handler must not send the ciphertext");
  });
  const list = server.slice(server.indexOf('app.get("/api/config/coolify"'), server.indexOf('app.post("/api/config/coolify/connections"'));
  assert.ok(list.includes("listConnectionsPublic"));
  assert.ok(!list.includes("token_enc"));
  assert.ok(routes.some((r) => r.method === "GET" && r.path === "/api/config/coolify/connections/:id/token"));
  assert.ok(routes.some((r) => r.method === "GET" && r.path === "/api/config/supabase/connections/:id/token"));
});
t("connections are one page and the add button sits above the table", () => {
  assert.ok(configHtml.includes('data-view="connections"'));
  assert.ok(!configHtml.includes('data-view="coolify"'));
  assert.ok(!configHtml.includes('data-view="supabase"'));
  const section = configHtml.slice(configHtml.indexOf('id="view-connections"'), configHtml.indexOf('id="view-alerts"'));
  const add = section.indexOf('id="addConnBtn"');
  const table = section.indexOf("<table>");
  assert.ok(add > 0 && table > add, "Add connection must sit above the table");
  assert.ok(section.includes('id="connAddModal"') === false);
  assert.ok(configHtml.includes('id="caType"'));
  assert.ok(configHtml.includes("tokenPreview"));
});
t("the edit modal can copy and reveal a token without saving it unchanged", () => {
  assert.ok(configHtml.includes('id="ceCopy"'));
  assert.ok(configHtml.includes('id="ceView"'));
  assert.ok(configHtml.includes('aria-label="Copy token"'));
  assert.ok(configHtml.includes('aria-label="Show token"'));
  assert.ok(configHtml.includes('"/token?event=view"'));
  assert.ok(!configHtml.includes("Paste to replace the saved token"));
  const saveAt = configHtml.indexOf('$("#ceSave").addEventListener');
  assert.ok(saveAt > 0 && configHtml.indexOf("editTokenChange()", saveAt) > saveAt);
  const start = configHtml.indexOf("function tokenReplacement");
  const end = configHtml.indexOf("function editTokenChange");
  assert.ok(start > 0 && end > start);
  const tokenReplacement = new Function(configHtml.slice(start, end) + "\nreturn tokenReplacement;")();
  const mask = "abc*******";
  assert.strictEqual(tokenReplacement("mask", mask, mask, null), undefined);
  assert.strictEqual(tokenReplacement("edit", mask, mask, null), undefined, "the masked preview must never be saved");
  assert.strictEqual(tokenReplacement("reveal", "abcdefghij", mask, "abcdefghij"), undefined);
  assert.strictEqual(tokenReplacement("edit", "", mask, null), undefined);
  assert.strictEqual(tokenReplacement("edit", "new-token", mask, "abcdefghij"), "new-token");
  assert.strictEqual(tokenReplacement("reveal", "new-token", mask, "abcdefghij"), "new-token");
});
t("delivery targets are edited inside the application dialog", () => {
  assert.ok(!configHtml.includes('data-view="targets"'));
  assert.ok(!configHtml.includes('id="tgtModal"'));
  const modal = configHtml.slice(configHtml.indexOf('id="appModal"'), configHtml.indexOf('id="connAddModal"'));
  assert.ok(modal.includes('id="amLines"'));
  assert.ok(modal.includes('id="amAddLine"'));
  assert.ok(modal.includes("傳送位置 Delivery targets"));
  const saveAt = configHtml.indexOf('$("#amSave").addEventListener');
  assert.ok(saveAt > 0 && configHtml.indexOf("persistTargets(", saveAt) > saveAt);
  assert.ok(configHtml.includes("Application saved, a delivery target failed"));
});
t("a Supabase auth target patches external_azure_secret", () => {
  assert.ok(configHtml.includes("Auth: Azure secret (external_azure_secret)"));
  assert.ok(configHtml.includes("Project secret"));
  assert.ok(configHtml.includes('class="tm-slot"'));
  assert.ok(configHtml.includes("supabaseTarget:"));
  const supabaseJs = fs.readFileSync(path.join(ROOT, "lib/supabase.js"), "utf8");
  assert.ok(supabaseJs.includes("/config/auth"));
  assert.ok(supabaseJs.includes("external_azure_secret"));
  assert.ok(supabaseJs.includes('method: "PATCH"'));
  assert.ok(supabaseJs.includes("config\\/auth"));
  const reg = fs.readFileSync(path.join(ROOT, "lib/regdb.js"), "utf8");
  assert.ok(reg.includes("supabase_target"));
  assert.ok(reg.includes('slot === "azure_auth" ? "external_azure_secret"'));
  const rotate = fs.readFileSync(path.join(ROOT, "lib/rotate.js"), "utf8");
  assert.ok(rotate.includes("setAzureSecret"));
  assert.ok(rotate.includes("the auth field cannot be restored"));
  const testRoute = server.slice(server.indexOf('app.post("/api/config/targets/:tid/test"'), server.indexOf("// ---- Coolify connections"));
  assert.ok(testRoute.includes('mode: azure ? "azure_auth"'));
  assert.ok(testRoute.includes('hint: azure ? ""'), "the target test must not return an auth secret");
});
t("creating and updating an application both reject an over-long lifetime", () => {
  const post = server.slice(server.indexOf('app.post("/api/config/apps"'), server.indexOf('app.put("/api/config/apps/:id"'));
  const put = server.slice(server.indexOf('app.put("/api/config/apps/:id"'), server.indexOf('app.delete("/api/config/apps/:id"'));
  assert.ok(post.includes("regdb.assertLifetimeMonths(b.lifetimeMonths)"), "POST does not enforce the cap");
  assert.ok(put.includes("regdb.assertLifetimeMonths((req.body || {}).lifetimeMonths)"), "PUT does not enforce the cap");
});

console.log("\n" + pass + " checks passed" + (process.exitCode ? " — WITH FAILURES" : "") +
  "  (" + routes.length + " routes, " + calls.length + " front-end calls)\n");
