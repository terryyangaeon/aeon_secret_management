// Create an account, or reset an existing one's password/role.
//
// Email account (password read from the environment so it stays out of shell history):
//   ACCOUNT_PASSWORD=... DATABASE_URL=... node scripts/create-account.js <email> [admin|user] [name]
//
// SSO account (signs in with the company Microsoft account, no password):
//   DATABASE_URL=... node scripts/create-account.js --sso <email> [admin|user] [name]
//
// On Zeabur: service → Command, with DATABASE_URL already in the environment.
const appdb = require("../lib/appdb");

(async () => {
  const argv = process.argv.slice(2);
  const sso = argv[0] === "--sso";
  const [email, role = "user", ...nameParts] = sso ? argv.slice(1) : argv;
  const password = process.env.ACCOUNT_PASSWORD || "";
  if (!email || (!sso && !password)) {
    console.error("Usage: ACCOUNT_PASSWORD=... node scripts/create-account.js <email> [admin|user] [name]");
    console.error("   or: node scripts/create-account.js --sso <email> [admin|user] [name]");
    process.exit(1);
  }
  await appdb.init();
  const name = nameParts.join(" ");
  const existing = await appdb.getAccount(email);
  const common = { name: name || (existing && existing.name) || "", role, active: true, bus: existing ? existing.bus : [] };
  const extra = sso ? { accountType: "sso", allowNoPassword: true } : { password };
  const acct = existing
    ? await appdb.updateAccount(email, Object.assign({}, common, extra))
    : await appdb.createAccount(Object.assign({ email }, common, extra));
  console.log((existing ? "Updated " : "Created ") + (sso ? "SSO " : "email ") + acct.role +
    " account " + acct.email + " (schema " + appdb.SCHEMA + ")");
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
