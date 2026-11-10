// Entra ID app registrations — list, and add/remove client secrets.
//
// With the Application.ReadWrite.OwnedBy permission, /applications returns ONLY
// the registrations where this app's service principal is listed as an Owner.
// That is deliberate: adding this app as an Owner in Entra is how a colleague
// opts a registration in to being managed here.
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

// Every registration this app is an Owner of.
async function listOwned() {
  const rows = await graph.graphList("/applications?$select=" + SELECT + "&$top=200");
  return rows.map(shape).sort((a, b) => a.name.localeCompare(b.name));
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

// The service principal for this app's own client id — used to tell the user
// which owner to add, and to recognise the tool's own registration.
async function self() {
  const r = await graph.graphFetch("/servicePrincipals?$select=id,appId,displayName&$top=1&$filter=" +
    encodeURIComponent("appId eq '" + String(process.env.SSO_CLIENT_ID || "").replace(/'/g, "''") + "'"));
  const sp = (r.value || [])[0];
  return sp ? { id: sp.id, appId: sp.appId, name: sp.displayName || "" } : null;
}

module.exports = { listOwned, getApp, addPassword, removePassword, credentialsOf, self };
