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

console.log("\n" + pass + " checks passed" + (process.exitCode ? " — WITH FAILURES" : "") +
  "  (" + routes.length + " routes, " + calls.length + " front-end calls)\n");
