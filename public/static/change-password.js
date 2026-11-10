/* Reusable "Change password" popup — include on any signed-in page and call
   window.openChangePassword(). Self-contained: injects its own styles + modal. */
(function () {
    var injected = false, overlay, els = {};

    function inject() {
        if (injected) return; injected = true;

        var css =
            '.cpw-overlay{position:fixed;inset:0;background:rgba(15,12,8,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:2000;}' +
            '.cpw-box{background:#fff;border-radius:14px;padding:24px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft JhengHei","PingFang TC",Roboto,sans-serif;}' +
            '.cpw-title{font-size:18px;font-weight:800;color:#90207a;margin-bottom:14px;}' +
            '.cpw-lbl{display:block;font-size:11px;color:#78716c;font-weight:600;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em;}' +
            '.cpw-lbl .lh{text-transform:none;letter-spacing:0;color:#a8a29e;font-weight:600;}' +
            '.cpw-box input[type=password],.cpw-box input[type=text]{width:100%;padding:10px 12px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;box-sizing:border-box;}' +
            '.cpw-box input:focus{outline:2px solid #FFCC00;border-color:#FFCC00;}' +
            '.cpw-show{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#44403c;font-weight:600;cursor:pointer;}' +
            '.cpw-show input{width:auto;}' +
            '.cpw-msg{min-height:18px;font-size:13px;margin-top:12px;text-align:center;}' +
            '.cpw-msg.err{color:#b91c1c;} .cpw-msg.ok{color:#15803d;}' +
            '.cpw-acts{display:flex;gap:8px;margin-top:16px;}' +
            '.cpw-acts .sp{flex:1;}' +
            '.cpw-btn{padding:9px 16px;border:1px solid transparent;border-radius:9px;font:inherit;font-weight:700;cursor:pointer;}' +
            '.cpw-btn.primary{background:#90207a;color:#fff;} .cpw-btn.primary:hover{background:#741964;}' +
            '.cpw-btn.ghost{background:#fff;border-color:#d6d3d1;color:#44403c;} .cpw-btn.ghost:hover{background:#fafaf9;}' +
            '.cpw-overlay[hidden]{display:none!important;}';
        var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

        overlay = document.createElement("div");
        overlay.className = "cpw-overlay"; overlay.hidden = true;
        overlay.innerHTML =
            '<div class="cpw-box" role="dialog" aria-modal="true" aria-label="Change password">' +
              '<div class="cpw-title">Change Password</div>' +
              '<label class="cpw-lbl" for="cpwCur">Current password</label>' +
              '<input type="password" id="cpwCur" autocomplete="current-password" placeholder="Your current password">' +
              '<label class="cpw-lbl" for="cpwNew">New password <span class="lh">(6 characters)</span></label>' +
              '<input type="password" id="cpwNew" autocomplete="new-password" placeholder="New password">' +
              '<label class="cpw-lbl" for="cpwNew2">Confirm new password</label>' +
              '<input type="password" id="cpwNew2" autocomplete="new-password" placeholder="Re-enter new password">' +
              '<label class="cpw-show"><input type="checkbox" id="cpwShow"> <span>Show passwords</span></label>' +
              '<div class="cpw-msg" id="cpwMsg"></div>' +
              '<div class="cpw-acts"><span class="sp"></span>' +
                '<button type="button" class="cpw-btn ghost" id="cpwCancel">Cancel</button>' +
                '<button type="button" class="cpw-btn primary" id="cpwSave">Update</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        ["cpwCur", "cpwNew", "cpwNew2", "cpwShow", "cpwMsg", "cpwCancel", "cpwSave"].forEach(function (id) { els[id] = overlay.querySelector("#" + id); });

        els.cpwShow.addEventListener("change", function () {
            var t = els.cpwShow.checked ? "text" : "password";
            els.cpwCur.type = t; els.cpwNew.type = t; els.cpwNew2.type = t;
        });
        els.cpwCancel.addEventListener("click", close);
        // Closes only via Cancel / Save — not on a backdrop click or Esc, so typed input isn't lost.
        els.cpwSave.addEventListener("click", submit);
        els.cpwNew2.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    }

    function msg(text, kind) { els.cpwMsg.textContent = text || ""; els.cpwMsg.className = "cpw-msg" + (kind ? " " + kind : ""); }
    function close() { overlay.hidden = true; }

    function submit() {
        var cur = els.cpwCur.value, nw = els.cpwNew.value, nw2 = els.cpwNew2.value;
        msg("");
        if (!cur) { msg("Enter your current password.", "err"); return; }
        if (nw.length < 6) { msg("New password must be at least 6 characters.", "err"); return; }
        if (nw !== nw2) { msg("New passwords do not match.", "err"); return; }
        els.cpwSave.disabled = true;
        fetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: cur, new_password: nw }) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                els.cpwSave.disabled = false;
                if (res.ok) { msg("Password updated.", "ok"); setTimeout(close, 1100); }
                else msg(res.j.message || res.j.error || "Could not change password.", "err");
            })
            .catch(function () { els.cpwSave.disabled = false; msg("Network error.", "err"); });
    }

    window.openChangePassword = function () {
        inject();
        els.cpwCur.value = ""; els.cpwNew.value = ""; els.cpwNew2.value = "";
        els.cpwShow.checked = false; els.cpwCur.type = els.cpwNew.type = els.cpwNew2.type = "password";
        msg(""); overlay.hidden = false;
        setTimeout(function () { els.cpwCur.focus(); }, 0);
    };
})();
