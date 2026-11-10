// Runs every test file. The rotation tests need a database:
//   docker compose up -d db
//   npm test
const { spawnSync } = require("child_process");
const files = ["tests/unit.test.js", "tests/routes.test.js", "tests/rotate.test.js"];
let bad = 0;
for (const f of files) {
  console.log("\n=== " + f + " ===");
  const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
