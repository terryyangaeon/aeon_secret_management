// Preload for manual / UI testing of the "save SSO account" directory check without a real tenant:
//   SSO_TENANT_ID=t SSO_CLIENT_ID=c SSO_CLIENT_SECRET=s PORT=18093 DATABASE_URL=<DEV db> \
//   node -r <path-to>/graph-stub.js server.js
// Fakes the Entra token endpoint and Graph /users; every other request uses the real fetch.
// Directory: new.colleague@aeondelightasia.com (enabled), left.staff@aeondelightasia.com (disabled);
// any other address is "not found". Pick a free port — 8093 may already be taken on this PC.
const realFetch = global.fetch;
const DIR = {
  "new.colleague@aeondelightasia.com": { id: "9", displayName: "New Colleague", userPrincipalName: "new.colleague@aeondelightasia.com", accountEnabled: true },
  "left.staff@aeondelightasia.com": { id: "2", displayName: "Left Staff", userPrincipalName: "left.staff@aeondelightasia.com", accountEnabled: false },
};
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200 });
  if (u.includes("/oauth2/v2.0/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (u.includes("graph.microsoft.com")) {
    const m = decodeURIComponent(u).match(/userPrincipalName eq '([^']*)'/);
    const x = DIR[m && m[1]];
    return json({ value: x ? [x] : [] });
  }
  return realFetch(url, opts);
};
