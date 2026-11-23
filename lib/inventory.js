// Keeps the local credential inventory in step with Entra, works out how long
// each secret has left, and sends the expiry warnings.
const graphapp = require("./graphapp");
const regdb = require("./regdb");
const mailer = require("./mailer");

const DAY = 24 * 3600 * 1000;

// Calendar days between today and the expiry date, in UTC — the same date the
// dashboard prints (the first 10 characters of the timestamp). Exact hours
// would put two secrets that expire on neighbouring dates into the same count
// whenever both instants fall inside one 24-hour window.
function daysLeft(endsAt, nowMs) {
  if (!endsAt) return null;
  const end = new Date(endsAt);
  if (isNaN(end.getTime())) return null;
  const now = new Date(nowMs == null ? Date.now() : nowMs);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((endDay - today) / DAY);
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
      id: t.id, label: t.label, kind: t.kind || "coolify",
      coolifyConnectionId: t.coolify_connection_id,
      coolifyConnectionName: t.coolify_connection_name || "",
      supabaseConnectionId: t.supabase_connection_id,
      supabaseConnectionName: t.supabase_connection_name || "",
      appUuid: t.app_uuid,
      appName: t.kind === "supabase" ? (t.supabase_connection_name || t.app_name || "Supabase") : t.app_name,
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
// opts.force re-sends even if that (secret, threshold) was already notified.
// The claim is still recorded, so the scheduler keeps deduping afterwards.
async function sendExpiryAlerts(opts) {
  const force = !!(opts && opts.force);
  const cfg = await mailer.getConfig();
  if (!(await mailer.enabled())) return { sent: 0, suppressed: 0, skipped: "alerts not configured" };
  const apps = await describeAll();
  let sent = 0, suppressed = 0;
  for (const a of apps) {
    if (!a.active || !a.current) continue;
    const d = a.daysLeft;
    if (d === null) continue;
    const hit = cfg.thresholds.filter((t) => d <= t).sort((x, y) => x - y)[0];
    if (hit === undefined) continue;
    const claimed = await regdb.claimAlert(a.id, a.current.keyId, hit);
    if (!claimed && !force) { suppressed++; continue; }
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
  return { sent, suppressed };
}

// Registrations that exist in Entra but are not tracked here.
//
// This is the blind spot Application.Read.All closes. With only
// ReadWrite.OwnedBy the app sees nothing it does not own, so a registration
// nobody opted in expires silently — which is how ITQPOMS-Prod went missing.
// → { apps: [...], tenantWide, total, owned }
async function unmanaged() {
  const inv = await graphapp.inventory();
  const known = await regdb.listApps();
  const knownOids = new Set(known.map((k) => k.entra_object_id));

  const apps = inv.apps.filter((a) => !knownOids.has(a.objectId)).map((a) => {
    // The live secret is unknowable from outside, so report the one that lasts
    // longest — the same assumption syncCredentials makes on a first sync.
    const secrets = (a.credentials || []).filter((c) => c.kind === "secret");
    const last = secrets.length ? secrets[secrets.length - 1] : null;
    const d = last ? daysLeft(last.endsAt) : null;
    return {
      name: a.name,
      clientId: a.clientId,
      entraObjectId: a.objectId,
      keyId: last ? last.keyId : null,
      owned: a.owned,                       // true | false | null (unknown)
      credentialCount: (a.credentials || []).length,
      endsAt: last ? last.endsAt : null,
      daysLeft: d,
      status: statusOf(d),
    };
  }).sort((x, y) => {
    const a = x.daysLeft === null ? 1e9 : x.daysLeft, b = y.daysLeft === null ? 1e9 : y.daysLeft;
    return a - b || x.name.localeCompare(y.name);
  });

  return { apps, tenantWide: inv.tenantWide, total: inv.total, owned: inv.owned };
}

// Warn about registrations nobody opted in.
//
// Without this they appear on the dashboard and nowhere else, so one expires
// quietly unless somebody happens to open the page — which is how two secrets
// in this tenant sat expired for 77 and 52 days. Needs Application.Read.All;
// without it there is nothing to say that the owned-set alerts do not cover.
//
// One digest rather than one mail per registration: forty registrations
// crossing a threshold should not be forty emails.
async function sendUntrackedAlerts(opts) {
  const force = !!(opts && opts.force);
  const cfg = await mailer.getConfig();
  if (!(await mailer.enabled())) return { sent: 0, suppressed: 0, skipped: "alerts not configured" };

  let inv;
  try { inv = await unmanaged(); }
  catch (e) { console.warn("untracked alerts: " + e.message); return { sent: 0, suppressed: 0, error: e.message }; }
  if (!inv.tenantWide) return { sent: 0, suppressed: 0, skipped: "no tenant-wide visibility (Application.Read.All)" };

  const due = [];
  let suppressed = 0;
  for (const a of inv.apps) {
    if (a.daysLeft === null || !a.keyId) continue;
    const hit = cfg.thresholds.filter((t) => a.daysLeft <= t).sort((x, y) => x - y)[0];
    if (hit === undefined) continue;
    const claimed = await regdb.claimUntrackedAlert(a.entraObjectId, a.keyId, hit);
    if (!claimed && !force) { suppressed++; continue; }
    due.push(Object.assign({ threshold: hit }, a));
  }
  if (!due.length) return { sent: 0, suppressed };

  due.sort((x, y) => x.daysLeft - y.daysLeft);
  const expired = due.filter((a) => a.daysLeft < 0).length;
  const subject = (expired ? "[EXPIRED] " : due[0].daysLeft <= 7 ? "[URGENT] " : "") +
    due.length + " untracked app registration" + (due.length === 1 ? "" : "s") +
    (expired ? " — " + expired + " already expired" : " expiring soon");

  const rows = due.map((a) =>
    "<tr>" +
    "<td style='padding:4px 14px 4px 0'><b>" + mailer.esc(a.name) + "</b></td>" +
    "<td style='padding:4px 14px 4px 0;font-family:monospace;font-size:12px'>" + mailer.esc(a.clientId) + "</td>" +
    "<td style='padding:4px 14px 4px 0;white-space:nowrap'>" + mailer.esc(String(a.endsAt).slice(0, 10)) + "</td>" +
    "<td style='padding:4px 14px 4px 0;white-space:nowrap;color:" + (a.daysLeft < 0 ? "#b91c1c" : a.daysLeft <= 7 ? "#b45309" : "#1c1917") + "'>" +
      (a.daysLeft < 0 ? "已過期 " + (-a.daysLeft) + " 天 · expired " + (-a.daysLeft) + "d ago" : a.daysLeft + " 天 · " + a.daysLeft + " days") + "</td>" +
    "<td style='padding:4px 0'>" + (a.owned === true ? "可更新 rotatable" : "未擁有 not owned") + "</td>" +
    "</tr>").join("");

  const body =
    "<p>以下應用程式註冊<b>未納入本系統管理</b>,密碼即將到期或已過期。本系統不會自動處理它們。 · " +
    "These app registrations are <b>not tracked</b> by this tool and their secrets are expiring or already " +
    "expired. <b>Nothing will be rotated automatically.</b></p>" +
    "<table style='border-collapse:collapse;margin:10px 0;font-size:13px'>" +
    "<tr style='color:#78716c;font-size:11px;text-transform:uppercase'>" +
    "<td style='padding:0 14px 6px 0'>Registration</td><td style='padding:0 14px 6px 0'>Client ID</td>" +
    "<td style='padding:0 14px 6px 0'>Expires</td><td style='padding:0 14px 6px 0'>Days left</td>" +
    "<td style='padding:0 0 6px 0'>Status</td></tr>" + rows + "</table>" +
    "<p>每個註冊可以:<br>" +
    "① 用 <code>scripts/add-owner.ps1</code> 加為擁有者並設定傳送位置 → 之後自動更新<br>" +
    "② 在 Entra 人手更新密碼<br>" +
    "③ 如果已經沒有東西使用,刪除該註冊<br>" +
    "· Either opt it in with <code>scripts/add-owner.ps1</code> and give it a delivery target, renew it by " +
    "hand in Entra, or delete the registration if nothing uses it any more.</p>";

  try {
    await mailer.send(subject, body);
    return { sent: 1, suppressed, registrations: due.length };
  } catch (e) {
    // Put every claim back so the next sweep tries again rather than going quiet.
    console.warn("untracked alert mail failed: " + e.message);
    for (const a of due) await regdb.releaseUntrackedAlert(a.entraObjectId, a.keyId, a.threshold).catch(() => {});
    return { sent: 0, suppressed, error: e.message };
  }
}

module.exports = { daysLeft, statusOf, nextRotation, isDue, describe, describeAll, refresh, sendExpiryAlerts, sendUntrackedAlerts, rowToInput, unmanaged };
