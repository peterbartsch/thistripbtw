/* pages.js — the only script the non-trip pages need: the menu, and which page you're on.
   Shared rather than copied into seven files, the same way sky.css already is. */
(function () {
  var mb = document.getElementById("menuBtn"), mn = document.getElementById("menu");
  if (mb && mn) {
    var sync = function () { mb.setAttribute("aria-expanded", mn.classList.contains("show") ? "true" : "false"); };
    mb.onclick = function (e) { e.stopPropagation(); mn.classList.toggle("show"); sync(); };
    document.addEventListener("click", function () { mn.classList.remove("show"); sync(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && mn.classList.contains("show")) { mn.classList.remove("show"); sync(); mb.focus(); }
    });
    // Mark the current page so the menu says where you are, not just where you can go.
    var here = location.pathname.replace(/\/$/, "");
    Array.prototype.forEach.call(mn.querySelectorAll("a"), function (a) {
      if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
    });
  }
})();
