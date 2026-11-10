// Email alerts through Microsoft Graph (application permission Mail.Send).
//
// Sender and recipients are set in Configuration → Alerts. With nothing
// configured this quietly does nothing: a missing mailbox must never be the
// reason a rotation fails.
const graph = require("./graph");
const appdb = require("./appdb");

const SETTING_KEY = "alerts";
const DEFAULTS = { sender: "", recipients: [], thresholds: [60, 30, 14, 7, 1], onRotation: true };

async function getConfig() {
  const v = (await appdb.getSetting(SETTING_KEY, null)) || {};
  const th = Array.isArray(v.thresholds) && v.thresholds.length
    ? v.thresholds.map((n) => parseInt(n, 10)).filter((n) => n > 0 && n <= 365).sort((a, b) => b - a)
    : DEFAULTS.thresholds;
  return {
    sender: String(v.sender || "").trim().toLowerCase(),
    recipients: (v.recipients || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean),
    thresholds: th,
    onRotation: v.onRotation !== false,
  };
}

async function setConfig(v) {
  const c = {
    sender: String(v.sender || "").trim().toLowerCase(),
    recipients: String(v.recipients === undefined ? "" : (Array.isArray(v.recipients) ? v.recipients.join(",") : v.recipients))
      .split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
    thresholds: (Array.isArray(v.thresholds) ? v.thresholds : String(v.thresholds || "").split(/[,;\s]+/))
      .map((n) => parseInt(n, 10)).filter((n) => n > 0 && n <= 365).sort((a, b) => b - a),
    onRotation: v.onRotation !== false,
  };
  if (!c.thresholds.length) c.thresholds = DEFAULTS.thresholds;
  const bad = c.recipients.concat(c.sender ? [c.sender] : []).find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw Object.assign(new Error("Not an email address: " + bad), { status: 400 });
  await appdb.setSetting(SETTING_KEY, c);
  return c;
}

const enabled = async () => {
  const c = await getConfig();
  return !!(graph.enabled() && c.sender && c.recipients.length);
};

// Returns true if sent, false if alerts aren't configured. Throws only on a
// real send failure, which callers log rather than propagate.
async function send(subject, html, to) {
  const c = await getConfig();
  const rcpt = (to && to.length ? to : c.recipients).filter(Boolean);
  if (!graph.enabled() || !c.sender || !rcpt.length) {
    console.warn("alert not sent (no sender/recipients configured):", subject);
    return false;
  }
  await graph.graphFetch("/users/" + encodeURIComponent(c.sender) + "/sendMail", {
    method: "POST",
    body: {
      message: {
        subject: String(subject).slice(0, 250),
        body: { contentType: "HTML", content: wrap(html) },
        toRecipients: rcpt.map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: false,
    },
  });
  return true;
}

const esc = (s) => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(inner) {
  return `<div style="font-family:-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;font-size:14px;color:#1c1917;line-height:1.6">
<div style="background:#FFCC00;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:700">密鑰管理 · Secret Management</div>
<div style="border:1px solid #e7e5e4;border-top:0;border-radius:0 0 10px 10px;padding:18px">${inner}
<p style="margin:18px 0 0;color:#78716c;font-size:12px">AEON Delight (Asia) — 此郵件由系統自動發出。 · Sent automatically by the Secret Management service.</p>
</div></div>`;
}

function table(rows) {
  return `<table style="border-collapse:collapse;margin:10px 0;font-size:13px">` + rows.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#78716c;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("") + `</table>`;
}

module.exports = { getConfig, setConfig, enabled, send, esc, table, DEFAULTS };
