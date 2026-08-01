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
  var ICON  = { auto: "◐", light: "☀", dark: "☾" };
  var NEXT  = { auto: "light", light: "dark", dark: "auto" };
  function byClock() {
    var h = new Date().getHours();
    return h < 5 ? "night" : h < 8 ? "dawn" : h < 18 ? "day" : h < 21 ? "dusk" : "night";
  }
  function apply(t) {
    d.setAttribute("data-sky", t === "light" ? "day" : t === "dark" ? "night" : byClock());
    d.setAttribute("data-pref", t);
    b.textContent = ICON[t];
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
