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

/* The condensing mark (Peter, 2026-08-03): "the header logo can shrink and move to the top left
   on first scroll."
   The header is ~250px of masthead, and once it has scrolled away the page carries no mark at
   all — nothing says whose site this is and the way home goes with it. A small one takes the
   TOP-LEFT, because the fixed menu and theme buttons own the right and running underneath them
   is the collision the header padding was just widened to avoid.
   A SEPARATE element rather than pinning the real sign: making an in-flow element `fixed`
   removes it from flow, and the header would collapse by its height the instant it engaged —
   a 111px jump under the reader's thumb.
   IntersectionObserver, not a scroll listener: no handler runs while scrolling, so there is
   nothing to throttle and nothing to jank. Guarded on `.pagehead .sign`, because this same file
   is loaded by /new, /quick and /quicktree, which have no page header at all. */
(function () {
  var sign = document.querySelector(".pagehead .sign");
  if (!sign || !("IntersectionObserver" in window)) return;
  var mini = document.createElement("a");
  mini.className = "minimark";
  mini.href = "/";
  /* Decorative, and deliberately not focusable. The menu already carries a real "Home" link on
     every one of these pages, so a keyboard user loses nothing — and a second tab stop pointing
     at the same place, which appears and disappears on scroll, is worse than not having it. */
  mini.setAttribute("aria-hidden", "true");
  mini.tabIndex = -1;
  mini.innerHTML = '<img src="/logo.svg?v=4" width="164" height="164" alt="">';
  document.body.appendChild(mini);
  new IntersectionObserver(function (e) {
    document.documentElement.classList.toggle("scrolled", !e[0].isIntersecting);
  }, { threshold: 0 }).observe(sign);
})();
