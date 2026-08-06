/* theme.js — the light/dark control on every non-trip page (D-084).
   THREE states, not two, and that is the whole design. sky.css has FOUR looks
   (day/dawn/dusk/night) chosen from the clock. A two-state toggle would have to map
   light→day and dark→night, which throws dawn and dusk away permanently on the first tap —
   the gradient is the nicest thing about these pages and most visitors would never see two
   thirds of it again. `auto` stays the default and keeps the time-of-day sky; light and dark
   are an OVERRIDE for anyone who wants one.
   Trip pages are deliberately NOT here: app.html has its own toggle over `data-theme`, because
   the map wants a flat surface behind it rather than a gradient. Same key, so a choice made on
   one carries to the other. */
(function () {
  var d = document.documentElement, b = document.getElementById("themeBtn");
  if (!b) return;
  var LABEL = { auto: "Sky follows the time of day", light: "Light", dark: "Night drive" };
  /* SVG, not characters (2026-08-05). The dingbats rendered differently on every platform
     and were the most dated thing in the chrome. THREE states stay, deliberately: D-084
     kept auto so dawn and dusk are not discarded by a two-way switch, and the half-filled
     circle is what auto means — the sky follows the clock. */
  var ICON  = {
    auto:  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M12 3.4a8.6 8.6 0 0 1 0 17.2z" fill="currentColor" stroke="none"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>',
    dark:  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2z"/></svg>'
  };
  var NEXT  = { auto: "light", light: "dark", dark: "auto" };
  function byClock() {
    var h = new Date().getHours();
    return h < 5 ? "night" : h < 8 ? "dawn" : h < 18 ? "day" : h < 21 ? "dusk" : "night";
  }
  function apply(t) {
    d.setAttribute("data-sky", t === "light" ? "day" : t === "dark" ? "night" : byClock());
    d.setAttribute("data-pref", t);
    b.innerHTML = ICON[t];
    b.title = LABEL[t];
    b.setAttribute("aria-label", "Theme: " + LABEL[t] + ". Tap to change.");
  }
  var cur = "auto";
  try { cur = localStorage.getItem("ttb_theme") || "auto"; } catch (e) {}
  if (!ICON[cur]) cur = "auto";
  apply(cur);
  b.addEventListener("click", function (e) {
    e.stopPropagation();                       // the document listener in pages.js closes the menu
    cur = NEXT[cur];
    try { localStorage.setItem("ttb_theme", cur); } catch (e) {}
    apply(cur);
  });
  // On `auto` the sky is a function of the clock, so a page left open through dusk should follow.
  setInterval(function () { if (cur === "auto") apply("auto"); }, 300000);
})();

/* ── the signed-in indicator (Peter, 2026-08-05: "no indicator when signed out") ──────────
   Shown ONLY when signed in. A signed-out visitor sees byte-for-byte what they saw before —
   no element, and, more importantly, NO REQUEST.

   Why the localStorage flag exists. The session cookie is httpOnly on purpose, so script
   cannot read it and a page has no way to know whether asking is worthwhile. Without a hint
   every one of these sixteen pages would call /api/account/me on every load, for every
   anonymous visitor and every crawler, forever, to be told "no" — and this site already had
   585 crawler hits worth investigating in one window (§2r). The flag is written by /account,
   which is the one page that knows the answer authoritatively, and it RECONCILES on each
   visit so an expired session stops the asking and a session without a flag starts it.
   It is NOT a credential and proves nothing — the server still decides, and the worst a
   forged flag buys you is one request that answers `signed_in:false`.
   localStorage rather than a cookie because CLAUDE.md forbids adding cookies, and D-113
   already set the precedent: the browser remembering the person's own state leaves no record
   on our side and links nothing to anyone.

   The avatar is GENERIC and always will be. We hold an email and a list of trips — no name,
   no photo, nothing to draw from (D-036). A mark that stands for "you are signed in", not for
   who you are. */
(function () {
  var flag = null;
  try { flag = localStorage.getItem("ttb_acct"); } catch (e) {}
  if (!flag) return;                       /* signed out, or unknown: ask nothing, show nothing */

  var host = document.getElementById("themeBtn");
  if (!host || document.getElementById("acctBtn")) return;

  fetch("/api/account/me", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (!me || !me.signed_in) {
        /* The flag outlived its session — stop every other page asking. */
        try { localStorage.removeItem("ttb_acct"); } catch (e) {}
        return;
      }
      var a = document.createElement("a");
      a.id = "acctBtn";
      a.href = "/account";
      var n = (me.trips || []).length;
      a.title = "Signed in" + (n ? " — " + n + (n === 1 ? " trip" : " trips") : "");
      a.setAttribute("aria-label", a.title + ". Go to your account.");
      a.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.4" r="3.9"/><path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0"/></svg>';
      /* Before the theme button, so the two round controls stay adjacent and the account mark
         reads as part of the same set rather than a fourth thing bolted on. */
      host.parentNode.insertBefore(a, host);
    })
    .catch(function () {});
})();
