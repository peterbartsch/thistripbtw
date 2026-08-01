/* R1: the replay day boundary must not depend on where you are watching from.
 *
 * A trip is SHARED — that is the product — so two people opening the same replay have to see the
 * same posts on the same day. `replayT` is a bare date and `p.ts` is a UTC epoch, so the
 * comparison has to choose a timezone. It used to choose the viewer's, and Auckland and Tokyo
 * pushed a 21:00 UTC post into a later frame than Denver did.
 *
 * This extracts the REAL expression out of app.html rather than restating it — a restated copy
 * would keep passing after the source drifted. Zones are varied by spawning a child process per
 * zone, because Date parsing reads the process TZ and cannot be varied in-process; a test that
 * pretended otherwise would prove nothing.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const app = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
const m = app.match(/const end = new Date\(replayT\s*\+\s*("[^"]+")\)\.getTime\(\);/);

let pass = 0, fail = 0;
const ok = (what, cond) => {
  if (cond) { pass++; console.log("  ok   " + what); }
  else      { fail++; console.log("  FAIL " + what); }
};

ok("the day-boundary expression was found in app.html", !!m);
if (!m) { console.log("\n1 failed"); process.exit(1); }

const suffix = m[1];
ok("it parses as UTC, not the viewer's local time", suffix.includes("Z"));

/* A post at 21:00 UTC on 2026-09-05. West of UTC it is still the 5th locally; east of it, the
   6th — which is exactly why the viewer's zone must not decide. */
const ZONES = ["Pacific/Auckland", "Asia/Tokyo", "UTC", "America/Denver", "Pacific/Honolulu"];
const script = `
  const post = Date.UTC(2026, 8, 5, 21, 0, 0);
  const end = new Date("2026-09-05" + ${suffix}).getTime();
  process.stdout.write(String(post <= end));`;

const verdicts = ZONES.map((tz) =>
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString());

ok("every timezone agrees (" + [...new Set(verdicts)].join(",") + ")", new Set(verdicts).size === 1);
ZONES.forEach((tz, i) => console.log("       " + tz.padEnd(19) + verdicts[i]));

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
