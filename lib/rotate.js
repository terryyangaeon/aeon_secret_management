// Secret rotation: scheduler + the rotation itself.
//
// The old secret stays valid for the whole run. Nothing is deleted from Entra
// until the new secret is in place and the app has answered a health check, so
// a failure anywhere in the middle leaves a working app behind.
//
//   1  create a new secret in Entra (addPassword)
//   2  store its value encrypted  ← Graph hands the value over exactly once
//   3  per target: snapshot the current variable value, then write the new one
//   4  restart each affected Coolify application
//   5  health-check the app
//   6  only now: delete the old secret from Entra
//
// Anything failing at 3-5 restores the snapshots, restarts again, and removes
// the *new* secret — the app carries on with the old one.
const appdb = require("./appdb");
const regdb = require("./regdb");
const graphapp = require("./graphapp");
const coolify = require("./coolify");
const mailer = require("./mailer");
const inventory = require("./inventory");

const INTERVAL_MIN = Math.max(5, parseInt(process.env.ROTATE_INTERVAL_MIN || "60", 10));
const ENABLED = process.env.ROTATE_ENABLED !== "0";
const LOCK_ID = 727275;                         // this app's advisory lock (Hikvision uses 727274)
const RUN_LOG_DAYS = parseInt(process.env.RUN_LOG_DAYS || "180", 10);
const HEALTH_TOTAL_MS = Math.max(10000, parseInt(process.env.HEALTH_TIMEOUT_MS || "120000", 10));
const HEALTH_EVERY_MS = 5000;
const SETTLE_MS = Math.max(0, parseInt(process.env.RESTART_SETTLE_MS || "8000", 10));

let timer = null, running = false;
const busy = new Set();                          // app ids being rotated right now

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  if (timer) return;
  if (!ENABLED) { console.log("Rotation scheduler disabled (ROTATE_ENABLED=0)"); return; }
  console.log("Rotation check every " + INTERVAL_MIN + " min");
  setTimeout(sweep, 20 * 1000);
  timer = setInterval(sweep, INTERVAL_MIN * 60 * 1000);
}

// One scheduled pass: refresh the inventory, send warnings, rotate what's due.
// Guarded by a Postgres advisory lock so two replicas never both rotate.
async function sweep() {
  if (running) return;
  running = true;
  let client = null;
  try {
    client = await appdb.pool.connect();
    const got = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID])).rows[0].ok;
    if (!got) { console.log("rotation sweep skipped — another instance holds the lock"); return; }
    try {
      await regdb.releaseStaleRuns();
      const inv = await inventory.refresh();
      if (inv.failed.length) console.warn("inventory refresh: " + inv.failed.length + " app(s) failed");
      await inventory.sendExpiryAlerts().catch((e) => console.warn("expiry alerts:", e.message));

      const apps = await regdb.listApps();
      for (const a of apps) {
        try {
          const cur = await regdb.currentCredential(a.id);
          if (!inventory.isDue(a, cur)) continue;
          if (busy.has(a.id)) continue;
          console.log("rotating " + a.name + " (due)");
          await rotateApp(a, "schedule", "");
        } catch (e) {
          console.warn("rotate " + a.name + " failed: " + e.message);
        }
      }
      await regdb.pruneRuns(RUN_LOG_DAYS);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    }
  } catch (e) {
    console.warn("rotation sweep error:", e.message);
  } finally {
    if (client) client.release();
    running = false;
  }
}

// Fire-and-forget: throws straight away if already running, otherwise the HTTP
// route returns {started:true} and the work carries on in the background.
function rotateManual(app, actor) {
  if (busy.has(app.id)) throw Object.assign(new Error("此應用程式正在更新中。 · A rotation is already running for this application."), { status: 409 });
  rotateApp(app, "manual", actor).catch((e) => console.warn("manual rotate " + app.name + ": " + e.message));
  return true;
}

const isBusy = (id) => busy.has(id);

// ---- The rotation -----------------------------------------------------------

async function rotateApp(app, trigger, actor) {
  if (busy.has(app.id)) throw Object.assign(new Error("A rotation is already running for this application."), { status: 409 });
  busy.add(app.id);

  const runId = await regdb.startRun(app.id, trigger, actor);
  const written = [];                 // targets whose variable we changed
  let newKey = null, oldKey = null;

  try {
    const targets = await regdb.listTargets(app.id);
    if (!targets.length) throw new Error("未設定傳送位置。 · No delivery target is configured — the new secret would have nowhere to go.");
    if (!(await coolify.configured())) throw new Error("尚未設定 Coolify 連線。 · Coolify is not connected — add the server URL and an API token in Configuration.");

    const cur = await regdb.currentCredential(app.id);
    oldKey = cur ? cur.key_id : "";
    await regdb.step(runId, "start", true, "targets: " + targets.map((t) => (t.app_name || t.app_uuid) + "/" + t.var_name).join(", "));

    // 1 + 2 — new secret, persisted before anything else can fail.
    const months = Math.min(24, Math.max(1, app.lifetime_months || 12));
    const ends = new Date(); ends.setMonth(ends.getMonth() + months);
    const made = await graphapp.addPassword(app.entra_object_id, {
      displayName: "auto-" + new Date().toISOString().slice(0, 10),
      endDateTime: ends.toISOString(),
    });
    newKey = made.keyId;
    await regdb.saveSecretValue(app.id, made.keyId, made.secretText);
    await regdb.addCredentialRow(app.id, { keyId: made.keyId, displayName: "auto-" + new Date().toISOString().slice(0, 10), endsAt: made.endsAt });
    await regdb.step(runId, "entra.addPassword", true, "new keyId " + made.keyId + ", expires " + String(made.endsAt).slice(0, 10));

    // 3 — snapshot, then write.
    for (const t of targets) {
      await snapshot(runId, t, app, cur);
      const res = await coolify.setVariable(t.app_uuid, t.var_name, made.secretText);
      written.push(t);
      await regdb.step(runId, "coolify.setVariable", true, (t.app_name || t.app_uuid) + "/" + t.var_name + " (" + res.mode + ")");
    }

    // 4 — restart each distinct service once.
    await restartAll(runId, targets);

    // 5 — health check.
    await healthCheck(runId, app, targets);

    // 6 — the old secret is now safe to remove.
    await regdb.setCurrent(app.id, made.keyId);
    await regdb.markCreatedHere(app.id, made.keyId);
    if (oldKey && oldKey !== made.keyId) {
      try {
        await graphapp.removePassword(app.entra_object_id, oldKey);
        await regdb.deleteCredentialRow(app.id, oldKey);
        await regdb.deleteSecretValue(app.id, oldKey);
        await regdb.clearAlerts(app.id, oldKey);
        await regdb.step(runId, "entra.removePassword", true, "old keyId " + oldKey + " deleted");
      } catch (e) {
        // The rotation itself worked; a leftover old secret is untidy, not broken.
        await regdb.step(runId, "entra.removePassword", false, e.message);
      }
    }

    await regdb.touchRotated(app.id);
    await regdb.finishRun(runId, { status: "ok", oldKeyId: oldKey, newKeyId: made.keyId });
    await notify(app, runId, "ok", { oldKey, newKey: made.keyId, endsAt: made.endsAt, targets });
    console.log("rotated " + app.name + " → " + made.keyId);
    return { ok: true, runId, keyId: made.keyId };

  } catch (e) {
    await regdb.step(runId, "failed", false, e.message);
    const rolled = await rollback(runId, app, written, newKey).catch((re) => {
      console.error("ROLLBACK FAILED for " + app.name + ": " + re.message);
      return { ok: false, error: re.message };
    });
    await regdb.finishRun(runId, {
      status: rolled.ok ? "rolled_back" : "error",
      error: e.message + (rolled.ok ? "" : " — ROLLBACK ALSO FAILED: " + rolled.error),
      oldKeyId: oldKey, newKeyId: newKey || "",
    });
    await notify(app, runId, rolled.ok ? "rolled_back" : "error", { error: e.message, rollback: rolled }).catch(() => {});
    throw e;
  } finally {
    busy.delete(app.id);
  }
}

// Remember what the variable held, so a failure can put it back. A Coolify
// token without read:sensitive can list names but not values; then fall back to
// the secret value we stored when we last issued one for this app.
async function snapshot(runId, t, app, cur) {
  let value = null, how = "none";
  try {
    const v = await coolify.getVariable(t.app_uuid, t.var_name);
    if (v.exists && v.readable) { value = v.value; how = "read from Coolify"; }
    else if (!v.exists) how = "variable does not exist yet";
    else how = "Coolify did not return the value (token needs read:sensitive)";
  } catch (e) {
    how = "read failed: " + e.message;
  }
  if (value === null && cur) {
    const stored = await regdb.readSecretValue(app.id, cur.key_id).catch(() => null);
    if (stored) { value = stored; how = "from this app's stored copy of the current secret"; }
  }
  await regdb.saveSnapshot(runId, t.id, value);
  await regdb.step(runId, "snapshot", value !== null, (t.app_name || t.app_uuid) + "/" + t.var_name + " — " + how);
}

async function restartAll(runId, targets) {
  const done = new Set();
  for (const t of targets) {
    if (!t.restart) continue;
    const k = t.app_uuid;
    if (done.has(k)) continue;
    done.add(k);
    await coolify.restartApplication(t.app_uuid);
    await regdb.step(runId, "coolify.restart", true, t.app_name || t.app_uuid);
  }
  if (done.size && SETTLE_MS) await sleep(SETTLE_MS);
}

// Poll every health URL until it answers < 400, or give up and fail the run.
async function healthCheck(runId, app, targets) {
  const urls = [];
  for (const t of targets) {
    const u = (t.health_url || "").trim() || (t.sort_order === 0 ? (app.app_url || "").trim() : "");
    if (u && urls.indexOf(u) < 0) urls.push(u);
  }
  if (!urls.length) {
    await regdb.step(runId, "health", true, "skipped — no health URL configured");
    return;
  }
  for (const u of urls) {
    const until = Date.now() + HEALTH_TOTAL_MS;
    let last = "";
    for (;;) {
      try {
        const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(10000) });
        if (r.status < 400) { await regdb.step(runId, "health", true, u + " → HTTP " + r.status); break; }
        last = "HTTP " + r.status;
      } catch (e) {
        last = e.name === "TimeoutError" ? "timed out" : e.message;
      }
      if (Date.now() >= until) {
        await regdb.step(runId, "health", false, u + " → " + last);
        throw new Error("健康檢查失敗 · Health check failed after restart: " + u + " → " + last);
      }
      await sleep(HEALTH_EVERY_MS);
    }
  }
}

// Put every variable we touched back, restart, and delete the new Entra secret.
async function rollback(runId, app, written, newKey) {
  if (!written.length && !newKey) return { ok: true, nothing: true };
  let restored = 0, failed = [];
  for (const t of written) {
    try {
      const prev = await regdb.readSnapshot(runId, t.id);
      if (prev === null) { failed.push((t.app_name || t.app_uuid) + "/" + t.var_name + " (no snapshot)"); continue; }
      await coolify.setVariable(t.app_uuid, t.var_name, prev);
      restored++;
    } catch (e) {
      failed.push((t.app_name || t.app_uuid) + "/" + t.var_name + " (" + e.message + ")");
    }
  }
  if (restored) await restartAll(runId, written).catch((e) => failed.push("restart (" + e.message + ")"));
  await regdb.step(runId, "rollback.variables", !failed.length,
    restored + " restored" + (failed.length ? "; could not restore: " + failed.join(", ") : ""));

  if (newKey) {
    try {
      await graphapp.removePassword(app.entra_object_id, newKey);
      await regdb.deleteCredentialRow(app.id, newKey);
      await regdb.deleteSecretValue(app.id, newKey);
      await regdb.step(runId, "rollback.removeNewSecret", true, newKey);
    } catch (e) {
      failed.push("remove new secret (" + e.message + ")");
      await regdb.step(runId, "rollback.removeNewSecret", false, e.message);
    }
  }
  // The old secret was never touched, so the app still works even when a
  // variable could not be put back — but say so loudly.
  return failed.length ? { ok: false, error: failed.join("; ") } : { ok: true, restored };
}

// ---- Result email -----------------------------------------------------------

async function notify(app, runId, status, info) {
  const cfg = await mailer.getConfig();
  if (!cfg.onRotation && status === "ok") return;
  const title = {
    ok: "[OK] ", rolled_back: "[ROLLED BACK] ", error: "[FAILED] ",
  }[status] || "";
  const subject = title + app.name + " — client secret rotation " +
    (status === "ok" ? "succeeded" : status === "rolled_back" ? "was rolled back" : "failed");

  let body;
  if (status === "ok") {
    body = "<p><b>" + mailer.esc(app.name) + "</b> 的用戶端密碼已自動更新。 · The client secret was replaced automatically.</p>" +
      mailer.table([
        ["Application", app.name],
        ["New secret expires", String(info.endsAt).slice(0, 10)],
        ["New key id", info.newKey],
        ["Old key id", info.oldKey ? info.oldKey + " (deleted)" : "—"],
        ["Delivered to", (info.targets || []).map((t) => (t.app_name || t.app_uuid) + " / " + t.var_name).join("<br>") || "—"],
        ["Run", "#" + runId],
      ]);
  } else if (status === "rolled_back") {
    body = "<p style='color:#b45309'><b>更新失敗，已還原。 · The rotation failed and was rolled back.</b> " +
      "舊密碼仍然有效，應用程式不受影響。 · The old secret was never deleted, so the app keeps working.</p>" +
      mailer.table([["Application", app.name], ["Reason", info.error], ["Run", "#" + runId]]) +
      "<p>請在系統內查看該次更新的步驟記錄。 · Open the run log in Secret Management for the step-by-step detail.</p>";
  } else {
    body = "<p style='color:#b91c1c'><b>更新失敗，且還原未完成 — 需要人手處理。 · The rotation failed AND the rollback did not finish — this needs a person.</b></p>" +
      mailer.table([
        ["Application", app.name],
        ["Reason", info.error],
        ["Rollback problem", (info.rollback && info.rollback.error) || "—"],
        ["Run", "#" + runId],
      ]) +
      "<p>請檢查 Coolify 的環境變數與 Entra 的用戶端密碼是否一致。 · Check that the Coolify variable and the Entra secret still match.</p>";
  }
  await mailer.send(subject, body).catch((e) => console.warn("rotation mail failed:", e.message));
}

module.exports = { start, sweep, rotateApp, rotateManual, isBusy, INTERVAL_MIN, ENABLED, LOCK_ID };
