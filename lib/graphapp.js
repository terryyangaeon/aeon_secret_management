// Entra ID app registrations — list, and add/remove client secrets.
//
// Two Graph permissions, doing two different jobs:
//
//   Application.ReadWrite.OwnedBy  what this app may CHANGE. Only registrations
//                                  where its service principal is an Owner, so
//                                  adding it as an owner is how a registration
//                                  is opted in to rotation.
//   Application.Read.All           (optional) what this app may SEE. Read-only
//                                  across the whole tenant, so a registration
//                                  nobody opted in still shows on the dashboard
//                                  and still gets warned about.
//
// Without Read.All, /applications returns the owned set only and everything
// below still works — the tenant-wide view simply collapses to the owned one.
const graph = require("./graph");

const SELECT = "id,appId,displayName,createdDateTime,signInAudience,passwordCredentials,keyCredentials,web,identifierUris,notes";

function shape(a) {
  return {
    objectId: a.id,
    clientId: a.appId,
    name: a.displayName || "",
    createdAt: a.createdDateTime || null,
    signInAudience: a.signInAudience || "",
    redirectUris: (a.web && a.web.redirectUris) || [],
    credentials: credentialsOf(a),
  };
}

// Client secrets and certificates, newest expiry last.
function credentialsOf(a) {
  const secrets = (a.passwordCredentials || []).map((c) => ({
    keyId: c.keyId, kind: "secret", displayName: c.displayName || "",
    hint: c.hint || "", startsAt: c.startDateTime || null, endsAt: c.endDateTime || null,
  }));
  const certs = (a.keyCredentials || []).map((c) => ({
    keyId: c.keyId, kind: "certificate", displayName: c.displayName || "",
    hint: (c.customKeyIdentifier || "").slice(0, 8), startsAt: c.startDateTime || null, endsAt: c.endDateTime || null,
  }));
  return secrets.concat(certs).sort((x, y) => String(x.endsAt).localeCompare(String(y.endsAt)));
}

// Every registration this app can see: the whole tenant with Application.Read.All,
// otherwise just the ones it owns.
async function listVisible() {
  const rows = await graph.graphList("/applications?$select=" + SELECT + "&$top=200");
  return rows.map(shape).sort((a, b) => a.name.localeCompare(b.name));
}

// The object ids this app's service principal owns — one call, rather than
// asking /applications/{id}/owners once per registration.
// null means "could not tell" (no service principal, or the call was refused).
let ownedCache = null, ownedCacheAt = 0;
const OWNED_TTL_MS = 5 * 60 * 1000;
async function ownedObjectIds(force) {
  if (!force && ownedCache && Date.now() - ownedCacheAt < OWNED_TTL_MS) return ownedCache;
  const sp = await self().catch(() => null);
  if (!sp) return null;
  try {
    const rows = await graph.graphList("/servicePrincipals/" + encodeURIComponent(sp.id) +
      "/ownedObjects/microsoft.graph.application?$select=id&$top=200");
    ownedCache = new Set(rows.map((r) => r.id));
    ownedCacheAt = Date.now();
    return ownedCache;
  } catch (e) {
    console.warn("could not read owned objects: " + e.message);
    return null;
  }
}

// → { apps: [...with .owned true|false|null], tenantWide: bool, owned: n, total: n }
// tenantWide is true when this app can see registrations it does not own, which
// is only possible with Application.Read.All.
async function inventory(force) {
  const apps = await listVisible();
  const owned = await ownedObjectIds(force);
  for (const a of apps) a.owned = owned ? owned.has(a.objectId) : null;
  const ownedCount = owned ? apps.filter((a) => a.owned).length : apps.length;
  return {
    apps,
    owned: ownedCount,
    total: apps.length,
    tenantWide: !!owned && apps.length > ownedCount,
  };
}

// Registrations this app may rotate. Kept as its own call because everything
// that WRITES must go through the owned set, never the tenant-wide one.
async function listOwned(force) {
  const inv = await inventory(force);
  return inv.apps.filter((a) => a.owned !== false);
}

async function getApp(objectId) {
  return shape(await graph.graphFetch("/applications/" + encodeURIComponent(objectId) + "?$select=" + SELECT));
}

// Returns { keyId, secretText, endsAt }. secretText is returned by Graph ONCE —
// the caller must persist it before doing anything that can fail.
async function addPassword(objectId, opts) {
  const o = opts || {};
  const j = await graph.graphFetch("/applications/" + encodeURIComponent(objectId) + "/addPassword", {
    method: "POST",
    body: { passwordCredential: { displayName: o.displayName || "rotated", endDateTime: o.endDateTime } },
  }).catch((e) => {
    // AEON's tenant caps client-secret lifetime (6 months at the time of
    // writing) through an application management policy. Asking for longer is
    // refused outright, so say which setting to change rather than "bad request".
    if (/lifetime|policy|AADSTS|exceed/i.test(e.message || "")) {
      throw graph.graphError("Entra refused the new secret's expiry date — the tenant's application " +
        "management policy caps how long a client secret may last. Lower “新密碼有效期 New Secret Validity (months <6)” " +
        "for this application in Configuration. (" + e.message + ")", 400, "lifetime_refused");
    }
    throw e;
  });
  if (!j || !j.secretText) throw graph.graphError("Entra did not return a new secret value.", 502, "no_secret_text");
  return { keyId: j.keyId, secretText: j.secretText, endsAt: j.endDateTime || o.endDateTime || null };
}

async function removePassword(objectId, keyId) {
  await graph.graphFetch("/applications/" + encodeURIComponent(objectId) + "/removePassword", {
    method: "POST", body: { keyId: String(keyId) },
  });
  return true;
}

// The same assignment scripts/add-owner.ps1 makes, done here so the dashboard
// can grant it. That script signs an administrator in interactively; this
// server has no PowerShell session, so it calls Graph as itself. Entra only
// allows that with Application.ReadWrite.All — OwnedBy cannot add an owner to
// a registration this app does not already own.
async function grantOwner(applicationObjectId) {
  const oid = String(applicationObjectId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oid)) {
    throw graph.graphError("Bad application id.", 400, "bad_application_id");
  }
  const sp = await self();
  if (!sp) throw graph.graphError("找不到本系統的服務主體。 · This tool's service principal was not found.", 503, "no_service_principal");
  const owners = await graph.graphList("/applications/" + encodeURIComponent(oid) + "/owners?$select=id");
  if (owners.some((o) => o.id === sp.id)) return { ok: true, already: true, servicePrincipalId: sp.id };
  await graph.graphFetch("/applications/" + encodeURIComponent(oid) + "/owners/$ref", {
    method: "POST",
    body: { "@odata.id": graph.BASE + "/directoryObjects/" + sp.id },
  }).catch((e) => {
    if (e.status === 403 || e.code === "graph_forbidden") {
      throw graph.graphError("Entra 拒絕加入擁有者。請在此應用程式的 API 權限加入 Application.ReadWrite.All 並授與管理員同意。" +
        "目前的 Application.ReadWrite.OwnedBy 不能把本系統加為尚未擁有的註冊的擁有者。 · " +
        "Entra refused to add the owner. Grant this app the Application.ReadWrite.All permission and admin consent. " +
        "Application.ReadWrite.OwnedBy cannot add this app as owner of a registration it does not already own." +
        (e.message ? " (" + e.message + ")" : ""), 403, "grant_forbidden");
    }
    throw e;
  });
  ownedCache = null;
  ownedCacheAt = 0;
  return { ok: true, already: false, servicePrincipalId: sp.id };
}

// The service principal for this app's own client id — used to tell the user
// which owner to add, and to recognise the tool's own registration.
async function self() {
  const r = await graph.graphFetch("/servicePrincipals?$select=id,appId,displayName&$top=1&$filter=" +
    encodeURIComponent("appId eq '" + String(process.env.SSO_CLIENT_ID || "").replace(/'/g, "''") + "'"));
  const sp = (r.value || [])[0];
  return sp ? { id: sp.id, appId: sp.appId, name: sp.displayName || "" } : null;
}

module.exports = { listVisible, listOwned, inventory, ownedObjectIds, getApp, addPassword, removePassword, grantOwner, credentialsOf, self };
