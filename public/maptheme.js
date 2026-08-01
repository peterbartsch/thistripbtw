/* maptheme.js — the light/dark control for the full-viewport map builders (D-087).
 *
 * TWO states here, not the three on the content pages, and that is not an inconsistency.
 * `theme.js` offers auto/light/dark because sky.css has FOUR looks chosen from the clock and a
 * two-state toggle would throw dawn and dusk away. There is no gradient here — the map fills the
 * screen — so there is nothing for `auto` to choose between beyond following the system, which
 * is exactly what happens when nothing is stored.
 *
 * The `ttb_theme` key is SHARED with the trip client and the content pages, so a choice made
 * anywhere carries everywhere. That means this has to cope with reading "auto", which it does by
 * falling back to the system preference rather than treating it as light.
 */
(function () {
  var d = document.documentElement, b = document.getElementById("themeBtn");
  if (!b) return;
  var LIGHT = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
  var DARK  = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  var saved = null;
  try { saved = localStorage.getItem("ttb_theme"); } catch (e) {}
  // "auto" and null both mean follow the system. Reading "auto" as light was a real bug in the
  // trip client while this key was shared but only ever written as light/dark.
  var dark = saved === "dark" ||
             (saved !== "light" && window.matchMedia &&
              matchMedia("(prefers-color-scheme: dark)").matches);
  var tiles = null;
  function apply() {
    d.setAttribute("data-theme", dark ? "dark" : "light");
    b.textContent = dark ? "☀" : "☾";
    b.title = dark ? "Day" : "Night drive";
    b.setAttribute("aria-label", "Theme: " + (dark ? "night drive" : "day") + ". Tap to change.");
    if (typeof map === "undefined" || !map || !window.L) return;
    if (tiles) map.removeLayer(tiles);
    tiles = L.tileLayer(dark ? DARK : LIGHT,
      { attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19 }).addTo(map);
    if (tiles.getContainer) tiles.getContainer().style.zIndex = 0;   // stay under the drawn route
  }
  apply();
  b.addEventListener("click", function (e) {
    e.stopPropagation();                       // pages.js closes the menu on a document click
    dark = !dark;
    try { localStorage.setItem("ttb_theme", dark ? "dark" : "light"); } catch (e) {}
    apply();
  });
})();
