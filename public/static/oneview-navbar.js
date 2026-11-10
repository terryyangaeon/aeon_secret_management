/* OneView Navbar — burger menu behaviour + signed-in user card.
   Same open/close/position behaviour as OneView / Device Management.

   Markup contract (see the oneview-navbar skill):
     <header class="top" data-me-url="/api/auth/me" data-logout-url="/api/auth/logout" data-login-url="/login.html">
       ... <button class="burger" id="burgerBtn"> ... <div class="menu" id="menu" hidden> ...
   Menu items:
     [data-admin-only]            shown only when the signed-in user's role is "admin"
     [data-email-only]            shown only for email + password accounts (accountType "email"), e.g. Change password
     button[data-action=changepw] calls window.openChangePassword() (change-password.js)
     button[data-action=logout]   POSTs to data-logout-url, then goes to data-login-url
   The .who card (#navWho / #navRole) is filled from data-me-url, which must
   return { user: { email, name, role, bus: [...] } }. */
(function () {
  var header = document.querySelector("header.top");
  var btn = document.getElementById("burgerBtn");
  var menu = document.getElementById("menu");
  if (!header || !btn || !menu) return;

  var meUrl = header.getAttribute("data-me-url") || "/api/auth/me";
  var logoutUrl = header.getAttribute("data-logout-url") || "/api/auth/logout";
  var loginUrl = header.getAttribute("data-login-url") || "/login.html";

  function close() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  function place() {
    var br = btn.getBoundingClientRect();
    menu.style.top = (br.bottom + 6) + "px";
    menu.style.right = Math.max(8, window.innerWidth - br.right) + "px";
    menu.style.left = "auto";
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var show = menu.hidden;
    if (show) place();
    menu.hidden = !show;
    btn.setAttribute("aria-expanded", String(show));
  });
  window.addEventListener("resize", function () { if (!menu.hidden) place(); });
  document.addEventListener("click", function (e) { if (!menu.contains(e.target)) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  menu.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-action]");
    if (!b) return;
    var action = b.getAttribute("data-action");
    close();
    if (action === "changepw" && window.openChangePassword) {
      window.openChangePassword();
    } else if (action === "logout") {
      fetch(logoutUrl, { method: "POST" }).then(function () { location.href = loginUrl; });
    }
  });

  // Signed-in user card + admin-only items
  function applyUser(u) {
    var isAdmin = !!(u && u.role === "admin");
    var who = document.getElementById("navWho"), role = document.getElementById("navRole");
    if (who) who.textContent = u ? (u.name || u.email) : "";
    if (role) role.textContent = !u ? "" : isAdmin ? "Admin — all business units"
      : "User — " + ((u.bus && u.bus.length) ? u.bus.join(", ") : "no business unit granted");
    Array.prototype.forEach.call(menu.querySelectorAll("[data-admin-only]"), function (el) { el.hidden = !isAdmin; });
    // SSO accounts manage their password with the company account, not here.
    Array.prototype.forEach.call(menu.querySelectorAll("[data-email-only]"), function (el) { el.hidden = !(u && u.accountType === "email"); });
  }
  window.oneviewNavbarSetUser = applyUser;   // pages that already fetched /me can pass it in
  if (!header.hasAttribute("data-no-fetch")) {
    fetch(meUrl, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { applyUser(j && j.user); })
      .catch(function () { applyUser(null); });
  }
})();
