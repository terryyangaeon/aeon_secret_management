/* Shared helpers for Secret Management (密鑰管理) pages.
   ES5, no build step, same conventions as the other OneView modules:
     api()    — fetch wrapper; a 401 bounces to the login page and throws {h:1}
                ("already handled, stay quiet")
     toast()  — transient feedback
     msg()    — a modal for anything the user must actually read
   Load with <script src="/static/appreg.js"></script> before the page script. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(v) {
    return String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        location.href = "/login.html?next=" + encodeURIComponent(location.pathname);
        throw { h: 1 };
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var er = new Error(j.message || j.error || "Request failed");
          er.status = r.status; er.code = j.code;
          throw er;
        }
        return j;
      });
    });
  }

  // ---- Toast ----
  var toastEl = null, toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  // ---- Message modal (closes only via its button) ----
  var msgEl = null;
  function msg(title, text, cb) {
    if (!msgEl) {
      msgEl = document.createElement("div");
      msgEl.className = "modal-overlay";
      msgEl.hidden = true;
      msgEl.innerHTML = '<div class="modal-box" style="max-width:440px">' +
        '<div class="modal-title" data-t></div><div data-b style="white-space:pre-wrap;line-height:1.6"></div>' +
        '<div class="modal-acts"><span style="flex:1"></span><button class="btn primary" data-ok>OK</button></div></div>';
      document.body.appendChild(msgEl);
      msgEl.querySelector("[data-ok]").addEventListener("click", function () {
        msgEl.hidden = true;
        var f = msgEl._cb; msgEl._cb = null;
        if (f) f();
      });
    }
    msgEl.querySelector("[data-t]").textContent = title;
    msgEl.querySelector("[data-b]").textContent = text;
    msgEl._cb = cb || null;
    msgEl.hidden = false;
  }

  function handleErr(e) {
    if (e && e.h) return;
    msg("出錯了 · Something went wrong", (e && e.message) || "Request failed.");
  }

  // ---- Formatting ----
  function fmtDate(v) { return v ? String(v).slice(0, 10) : "—"; }
  function fmtDateTime(v) { return v ? String(v).replace("T", " ").slice(0, 16) : "—"; }

  // "in 47 days" / "12 days ago", in both languages the rest of the UI uses.
  function fmtDays(d) {
    if (d === null || d === undefined) return "—";
    if (d < 0) return "已過期 " + (-d) + " 天 · expired " + (-d) + "d ago";
    if (d === 0) return "今天到期 · expires today";
    return d + " 天 · " + d + " day" + (d === 1 ? "" : "s");
  }

  var STATUS_TEXT = {
    ok: "正常 OK", warning: "快將到期 Soon", critical: "緊急 Urgent",
    expired: "已過期 Expired", unknown: "未知 Unknown"
  };
  function statusPill(s, d) {
    return '<span class="st ' + esc(s) + '">' + esc(STATUS_TEXT[s] || s) + "</span>";
  }

  var RUN_TEXT = { ok: "成功 OK", running: "進行中 Running", error: "失敗 Failed", rolled_back: "已還原 Rolled back" };
  function runPill(s) { return '<span class="st ' + esc(s) + '">' + esc(RUN_TEXT[s] || s) + "</span>"; }

  function stepsHtml(steps) {
    if (!steps || !steps.length) return '<p class="muted">No steps recorded.</p>';
    return '<ul class="steps">' + steps.map(function (s) {
      return '<li class="' + (s.ok ? "" : "bad") + '"><b>' + esc(s.step) + "</b>" +
        '<span class="when">' + esc(String(s.at).replace("T", " ").slice(11, 19)) + "</span>" +
        (s.detail ? '<span class="detail">' + esc(s.detail) + "</span>" : "") + "</li>";
    }).join("") + "</ul>";
  }

  window.AR = {
    $: $, $$: $$, esc: esc, api: api, toast: toast, msg: msg, handleErr: handleErr,
    fmtDate: fmtDate, fmtDateTime: fmtDateTime, fmtDays: fmtDays,
    statusPill: statusPill, runPill: runPill, stepsHtml: stepsHtml
  };
})();
