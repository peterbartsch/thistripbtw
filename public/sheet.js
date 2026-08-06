/* sheet.js — the bottom-sheet GESTURE, shared by the trip page and the builder.

   Extracted from app.html on 2026-08-05, where it had been shipping and being debugged for
   months. It is deliberately the gesture and NOTHING else: app.html moves its sheet with
   translateY and a class per state, /new moves its own by height, and forcing either to adopt
   the other's painting would be a rewrite of the part that already works. What both actually
   need is: start a drag on a handle, follow the finger, clamp it, and snap to the nearest
   resting state on release.

   The host owns the pixels. This owns the arithmetic.

   createSheetDrag({
     handles   [Element]        where a drag may begin
     states    [string]         resting states, CLOSED-to-OPEN order
     posFor    (state) => px    resting offset of a state, in the host's own space
     current   () => state      the host's current state (this module keeps no state of its own)
     onDrag    (px) => void     paint an in-flight position
     onSnap    (state) => void  commit a state
     max       () => px         clamp, so a drag cannot run off the bottom
     snapFor   (state) => px    OPTIONAL. Defaults to posFor. Only differs where a host wants a
                                snap threshold that is not the resting position — app.html has
                                had exactly that, by 20px, since before the extraction.
     snapStates [string]        OPTIONAL. Defaults to states. The states a RELEASE may land on,
                                which is not always every state: app.html has never let a drag
                                reach `shut` (its pill is the way back), so keyboard cycles four
                                and the finger snaps to three. Kept as a seam rather than
                                flattened, because the difference is real and deliberate.
     onStart / onEnd () => void OPTIONAL. Where the host kills its transition mid-drag.
   })
   → { destroy() }

   Keyboard lives here too, because a drag handle that only answers a finger is not a control.
   Enter/Space cycles, ArrowUp/ArrowDown step one state. */
(function (global) {
  function createSheetDrag(o) {
    var handles = o.handles.filter(Boolean);
    if (!handles.length) return { destroy: function () {} };

    var startY = 0, startPos = 0, cur = 0, dragging = false;
    var snapFor = o.snapFor || o.posFor;
    var snapStates = o.snapStates || o.states;

    function down(e) {
      /* A press on a real control inside the handle zone is that control's, not the sheet's.
         The handle itself is exempt — it IS a button, and it is the one you are meant to drag. */
      if (handles.indexOf(e.target) === -1 && e.target.closest("button,input,textarea,a,select")) return;
      startY = e.clientY;
      startPos = o.posFor(o.current());
      cur = startPos;
      dragging = true;
      if (o.onStart) o.onStart();
      global.addEventListener("pointermove", move);
      global.addEventListener("pointerup", up, { once: true });
      global.addEventListener("pointercancel", up, { once: true });
    }

    function move(e) {
      cur = Math.max(0, Math.min(o.max(), startPos + (e.clientY - startY)));
      o.onDrag(cur);
    }

    function up() {
      global.removeEventListener("pointermove", move);
      if (!dragging) return;
      dragging = false;
      if (o.onEnd) o.onEnd();
      /* Nearest resting state to where the finger let go. Sorting by distance rather than
         thresholding by direction is what makes a short drag feel like a correction and a long
         one like a decision, without either needing a velocity model. */
      var best = null, bestD = Infinity;
      snapStates.forEach(function (st) {
        var d = Math.abs(snapFor(st) - cur);
        if (d < bestD) { bestD = d; best = st; }
      });
      o.onSnap(best);
    }

    function key(e) {
      var i = o.states.indexOf(o.current());
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); o.onSnap(o.states[(i + 1) % o.states.length]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); o.onSnap(o.states[Math.min(o.states.length - 1, i + 1)]);
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); o.onSnap(o.states[Math.max(0, i - 1)]);
      }
    }

    handles.forEach(function (h) {
      h.addEventListener("pointerdown", down);
      h.addEventListener("keydown", key);
    });

    return {
      destroy: function () {
        handles.forEach(function (h) {
          h.removeEventListener("pointerdown", down);
          h.removeEventListener("keydown", key);
        });
        global.removeEventListener("pointermove", move);
      }
    };
  }

  global.createSheetDrag = createSheetDrag;
})(window);
