/* ?calm=1 — see the CSS block. Additive on purpose: if this whole script throws, the page is
   exactly the page that shipped, because nothing below runs unless the flag is present. */
(function(){
  /* PROMOTED TO THE DEFAULT 2026-08-11 (D-170), on the cold run: the create flow is "still too
     much / too hard to create / follow through". The hero offered FOUR ways in at equal weight —
     start a leg, describe it, open a file, explore the demo — and a first-timer has to choose
     before they have any idea what they are choosing between. Now it offers one, and the other
     three sit behind a single quiet line.
     `?ways=1` restores all four and it STAYS, same rule as D-165 and D-168: the promotion that
     deletes its own fallback needs it within the week. `?calm=1` still works and now changes
     nothing, so links already sent keep behaving. */
  var on=true; try{ on = !new URLSearchParams(location.search).has("ways"); }catch(e){ on=true; }
  if(!on) return;
  document.body.classList.add("calm");
  function line(cls, label, cls2){
    var b=document.createElement("button");
    b.type="button"; b.className="calm-more "+cls; b.textContent=label;
    b.onclick=function(){ document.body.classList.add(cls2); };
    return b;
  }
  var hero=document.getElementById("hero");
  if(hero) hero.appendChild(line("h","other ways to start","calm-open"));
  var prompt=document.querySelector(".prompt");
  if(prompt) prompt.appendChild(line("p","or start another way","calm-open2"));
})();
