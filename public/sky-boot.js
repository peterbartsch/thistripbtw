/* sky-boot.js - the time-of-day sky and the saved theme preference, set on <html> BEFORE first
   paint. Moved out of new.html on 2026-11-09 so the page's Content-Security-Policy can forbid
   inline script entirely; it was the last inline block on either Trips page.

   LOADED SYNCHRONOUSLY, IN PLACE, AND THAT IS THE WHOLE POINT. Not defer, not async, not moved
   to the foot of the page: it has to have set data-sky and data-pref before the first paint, or
   the page shows the wrong sky and then corrects itself, which reads as a flash. A classic
   script tag in the same spot blocks the parser exactly as the inline block did, so the ordering
   guarantee is unchanged - the cost is one request, and it is why this file is four lines.

   localStorage is wrapped: a browser with site data blocked throws on read, and a trip page that
   will not render is a worse failure than the default sky. */
(function(){var d=document.documentElement,t="auto";try{t=localStorage.getItem("ttb_theme")||"auto"}catch(e){}var h=new Date().getHours(),a=h<5?"night":h<8?"dawn":h<18?"day":h<21?"dusk":"night";d.setAttribute("data-sky",t==="light"?"day":t==="dark"?"night":a);d.setAttribute("data-pref",t)})();
