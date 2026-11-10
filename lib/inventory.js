// Keeps the local credential inventory in step with Entra, works out how long
// each secret has left, and sends the expiry warnings.
const graphapp = require("./graphapp");
const regdb = require("./regdb");
const mailer = require("./mailer");

const DAY = 24 * 3600 * 1000;

function daysLeft(endsAt) {
  if (!endsAt) return null;
  return Math.floor((new Date(endsAt).getTime() - Date.now()) / DAY);
}

// green / amber / red, same thresholds the dashboard pills use.
function statusOf(d) {
  if (d === null) return "unknown";
  if (d < 0) return "expired";
  if (d <= 7) return "critical";
  if (d <= 30) return "warning";
  return "ok";
}

// When the scheduler would next rotate this app.
function nextRotation(app, d) {
  if (!app.auto_rotate || !app.active) return null;
  if (app.rotation_mode === "manual") return null;
  if (app.rotation_mode === "monthly") {
    const now = new Date(), day = Math.min(28, app.monthly_day || 1);
    const next = new Date(now.getFullYear(), now.getMonth(), day, 3, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next.toISOString();
  }
  if (d === null) return null;
  const t = Date.now() + (d - (app.rotate_before_days || 30)) * DAY;
  return new Date(Math.max(Date.now(), t)).toISOString();
}

// Is this app due for rotation right now?
function isDue(app, cred) {
  if (!app.active || !app.auto_rotate || app.rotation_mode === "manual") return false;
  const d = cred ? daysLeft(cred.ends_at) : null;
  if (app.rotation_mode === "monthly") {
    const last = app.last_rotated_at ? new Date(app.last_rotated_at).getTime() : 0;
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth(), Math.min(28, app.monthly_day || 1), 3, 0, 0).getTime();
    // Due once the day has arrived this month and we haven't rotated since.
    if (Date.now() >= due && last < due) return true;
    // A secret about to die trumps the monthly cadence.
    return d !== null && d <= Math.max(2, app.rotate_before_days || 30);
  }
  return d !== null && d <= (app.rotate_before_days || 30);
}

// One app, decorated for the API and the pages.
async function describe(app) {
  const creds = await regdb.listCredentials(app.id);
  const cur = creds.find((c) => c.is_current) || null;
  const d = cur ? daysLeft(cur.ends_at) : null;
  const targets = await regdb.listTargets(app.id);
  return {
    id: app.id,
    name: app.name,
    entraObjectId: app.entra_object_id,
    clientId: app.client_id,
    appUrl: app.app_url,
    ownerEmail: app.owner_email,
    notes: app.notes,
    active: app.active,
    autoRotate: app.auto_rotate,
    rotationMode: app.rotation_mode,
    rotateBeforeDays: app.rotate_before_days,
    monthlyDay: app.monthly_day,
    lifetimeMonths: app.lifetime_months,
    lastRotatedAt: app.last_rotated_at,
    current: cur && {
      keyId: cur.key_id, displayName: cur.display_name, hint: cur.hint,
      endsAt: cur.ends_at, createdHere: cur.created_here,
    },
    endsAt: cur ? cur.ends_at : null,
    daysLeft: d,
    status: statusOf(d),
    nextRotation: nextRotation(app, d),
    targetCount: targets.length,
    ready: targets.length > 0,
    credentials: creds.map((c) => ({
      keyId: c.key_id, kind: c.kind, displayName: c.display_name, hint: c.hint,
      startsAt: c.starts_at, endsAt: c.ends_at, isCurrent: c.is_current,
      createdHere: c.created_here, daysLeft: daysLeft(c.ends_at), status: statusOf(daysLeft(c.ends_at)),
    })),
    targets: targets.map((t) => ({
      id: t.id, label: t.label, kind: t.kind,
      appUuid: t.app_uuid, appName: t.app_name,
      varName: t.var_name, restart: t.restart, healthUrl: t.health_url, sortOrder: t.sort_order,
    })),
  };
}

async function describeAll() {
  const apps = await regdb.listApps();
  const out = [];
  for (const a of apps) out.push(await describe(a));
  // Most urgent first, then by name.
  return out.sort((x, y) => {
    const a = x.daysLeft === null ? 1e9 : x.daysLeft, b = y.daysLeft === null ? 1e9 : y.daysLeft;
    return a - b || x.name.localeCompare(y.name);
  });
}

// Re-read every managed app's credentials from Entra. Per-app try/catch so one
// deleted or un-owned registration doesn't stop the sweep.
async function refresh() {
  const apps = await regdb.listApps();
  const result = { checked: 0, updated: 0, failed: [] };
  for (const a of apps) {
    if (!a.active) continue;
    result.checked++;
    try {
      const app = await graphapp.getApp(a.entra_object_id);
      await regdb.syncCredentials(a.id, app.credentials);
      // Keep the cached name/client id honest if they were renamed in Entra.
      if (app.clientId && app.clientId !== a.client_id) {
        await regdb.updateApp(a.id, Object.assign(rowToInput(a), { clientId: app.clientId }));
      }
      result.updated++;
    } catch (e) {
      console.warn("inventory " + a.name + ": " + e.message);
      result.failed.push({ app: a.name, error: e.message });
    }
  }
  return result;
}

// regdb.updateApp takes the camelCase input shape; this converts a row back.
function rowToInput(a) {
  return {
    name: a.name, clientId: a.client_id, appUrl: a.app_url, ownerEmail: a.owner_email, notes: a.notes,
    autoRotate: a.auto_rotate, rotationMode: a.rotation_mode, rotateBeforeDays: a.rotate_before_days,
    monthlyDay: a.monthly_day, lifetimeMonths: a.lifetime_months, active: a.active,
  };
}

// Warn once per (credential, threshold). Crossing 30 days sends the 30-day
// mail; it will not be sent again until that credential is replaced.
async function sendExpiryAlerts() {
  const cfg = await mailer.getConfig();
  if (!(await mailer.enabled())) return { sent: 0, skipped: "alerts not configured" };
  const apps = await describeAll();
  let sent = 0;
  for (const a of apps) {
    if (!a.active || !a.current) continue;
    const d = a.daysLeft;
    if (d === null) continue;
    const hit = cfg.thresholds.filter((t) => d <= t).sort((x, y) => x - y)[0];
    if (hit === undefined) continue;
    if (!(await regdb.claimAlert(a.id, a.current.keyId, hit))) continue;
    const when = d < 0 ? "已於 " + String(a.endsAt).slice(0, 10) + " 過期 · expired on " + String(a.endsAt).slice(0, 10)
      : "還有 " + d + " 天 · " + d + " day" + (d === 1 ? "" : "s") + " left";
    const subject = (d < 0 ? "[EXPIRED] " : d <= 7 ? "[URGENT] " : "") + a.name + " — client secret " + (d < 0 ? "has expired" : "expires in " + d + " days");
    const plan = a.autoRotate && a.ready
      ? "<p>此應用程式已啟用自動更新，系統會自行處理。 · Auto-rotation is on for this app — the service will replace the secret by itself and email the result.</p>"
      : "<p style='color:#b91c1c'><b>自動更新未啟用。 · Auto-rotation is not on for this app</b>" +
        (a.ready ? "" : " (no delivery target is configured)") + " — 請手動更新。 · it must be rotated by hand.</p>";
    const body = "<p><b>" + mailer.esc(a.name) + "</b> 的 Entra 用戶端密碼 " + mailer.esc(when) + "。</p>" +
      mailer.table([
        ["Application", a.name],
        ["Client ID", a.clientId || "—"],
        ["Secret", (a.current.displayName || "(unnamed)") + (a.current.hint ? "  ·  " + a.current.hint + "…" : "")],
        ["Expires", String(a.endsAt).replace("T", " ").slice(0, 16) + " UTC"],
        ["Days left", d],
        ["Auto-rotate", a.autoRotate ? "On" : "Off"],
        ["Delivery targets", a.targetCount],
      ]) + plan;
    try {
      await mailer.send(subject, body);
      sent++;
    } catch (e) {
      // Put the claim back so the next sweep tries again instead of going quiet.
      console.warn("alert mail failed for " + a.name + ": " + e.message);
      await regdb.clearAlerts(a.id, a.current.keyId).catch(() => {});
    }
  }
  return { sent };
}

module.exports = { daysLeft, statusOf, nextRotation, isDue, describe, describeAll, refresh, sendExpiryAlerts, rowToInput };
