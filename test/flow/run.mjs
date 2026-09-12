#!/usr/bin/env node
/* Run the flows, screenshot every step at both heights, write one report.
 *
 *   node test/flow/run.mjs                     # production, both viewports, all flows
 *   node test/flow/run.mjs --flow build-cold   # one flow
 *   node test/flow/run.mjs --head              # watch it happen
 *   TTB_BASE=http://127.0.0.1:8080 node test/flow/run.mjs
 *
 * Output lands in var/flow/<stamp>/ — report.md plus a PNG per step per viewport. `var/` is in
 * .htaccess rule 2's deny list, and that is not incidental: these screenshots contain whatever
 * trip the run built, and a directory is protected when a rule names it, never because nothing
 * links to it (CLAUDE.md, 2026-08-07). */
import { mkdirSync, writeFileSync } from "node:fs";
import { launch } from "./cdp.mjs";
import { PROBE } from "./probe.mjs";
import { FLOWS, VIEWPORTS, BASE } from "./flows.mjs";

const argv = process.argv.slice(2);
const only = argv.includes("--flow") ? argv[argv.indexOf("--flow") + 1] : null;
const headless = !argv.includes("--head");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = `var/flow/${stamp}`;
mkdirSync(outDir, { recursive: true });

const flows = FLOWS.filter(f => !only || f.id === only);
if (!flows.length) { console.error("no flow named " + only); process.exit(2); }

const report = [];
const findings = [];
const note = (flow, vp, step, kind, text) => findings.push({ flow, vp, step, kind, text });

console.log(`base ${BASE} · ${flows.length} flow(s) · ${VIEWPORTS.length} viewports\n`);
const page = await launch({ headless });

try {
  for (const flow of flows) {
    report.push(`\n## ${flow.title}\n\n\`${flow.id}\` · \`${flow.url}\`\n`);
    for (const vp of VIEWPORTS) {
      report.push(`\n### ${vp.name} — ${vp.note}\n`);
      await page.viewport(vp.w, vp.h);
      await page.reset(BASE);          // every flow starts cold, not on the last flow's draft
      page.clearErrors();
      await page.goto(BASE + flow.url);

      let n = 0;
      for (const step of flow.steps) {
        n++;
        let ok = true, err = null;
        try { ok = await step.do(page); } catch (e) { ok = false; err = e.message; }

        let probe;
        try { probe = await page.eval(PROBE); }
        catch (e) { probe = { error: e.message }; }

        const png = `${flow.id}-${vp.name}-${String(n).padStart(2, "0")}.png`;
        try { writeFileSync(`${outDir}/${png}`, Buffer.from(await page.shot(), "base64")); } catch {}

        const bits = [];
        if (ok === false) { bits.push("**control not found**" + (err ? ` — ${err}` : "")); note(flow.id, vp.name, step.name, "missing", "the step's control was not on screen" + (err ? ` (${err})` : "")); }
        /* A STEP MAY NOW ASSERT SOMETHING ABOUT THE PRODUCT, NOT ONLY REACH A CONTROL — return a
           STRING and it becomes a `claim` finding saying exactly that. Until 2026-09-04 every
           step answered one question, "was the control there", and `flow-diff` says so in its own
           output: "this compares MECHANICS only". That is why the harness was green while /new
           stored "San Mateo County, California" for a person who picked "SFO — San Francisco
           International Airport". Nothing was missing. Everything was the wrong thing.
           A claim is the cheapest way to say what a screen is FOR, and it is the only kind of
           finding here that can catch a product being confidently, mechanically wrong. */
        if (typeof ok === "string" && ok) { bits.push(`**claim failed** — ${ok}`); note(flow.id, vp.name, step.name, "claim", ok); }
        if (probe?.error) bits.push(`probe failed: ${probe.error}`);
        if (probe?.instrument && (!probe.instrument.visible || !probe.instrument.layoutLive))
          bits.push(`⚠ instrument: visible=${probe.instrument.visible} layoutLive=${probe.instrument.layoutLive} — treat these numbers as stale`);
        if (probe?.small?.length) {
          bits.push(`**${probe.small.length} under 44px:** ` + probe.small.map(s => `${s.what} (${s.w}×${s.h})`).join(", "));
          for (const s of probe.small) note(flow.id, vp.name, step.name, "tap-target", `${s.what} is ${s.w}×${s.h}`);
        }
        if (probe?.markersSmall?.length)
          bits.push(`map markers under 44px: ${probe.markersSmall.join(", ")} (cartography, not chrome)`);
        if (probe?.clipped?.length) {
          bits.push(`**${probe.clipped.length} UNREACHABLE below the fold:** ` + probe.clipped.map(c => `${c.what} @${c.top}`).join(", "));
          for (const c of probe.clipped) note(flow.id, vp.name, step.name, "clipped", `${c.what} sits at ${c.top} on a ${vp.h}px screen and nothing scrolls to it`);
        }
        if (probe?.stowed) bits.push(`${probe.stowed} stowed in a closed panel (not a defect on its own)`);
        const scrollable = (probe?.belowFold || []).filter(c => c.reachable).length;
        if (scrollable) bits.push(`${scrollable} below the fold but reachable by scrolling`);
        /* -- 2bt assertions. Order matters only in that the instrument check above runs first:
           if the pane is frozen, every number below is stale and the report already says so. */
        if (probe?.band) {
          const b = probe.band;
          if (b.impossible) bits.push(`⚠ instrument: band ${b.px} exceeds the viewport — stale, not a finding`);
          else if (b.hasLeg && b.px < 150) {
            bits.push(`**map band ${b.px}px** (need 150, MIN_BAND) — chrome clear from ${b.top} to ${b.bottom}`);
            note(flow.id, vp.name, step.name, "band", `only ${b.px}px of map is clear with a leg drawn; frameTrip pads to MIN_BAND 150`);
          } else if (b.hasLeg) bits.push(`map band ${b.px}px`);
        }
        if (probe?.bare?.length) {
          bits.push(`**${probe.bare.length} bare on the sky (sky=${probe.sky}):** ` + probe.bare.join(", "));
          for (const t of probe.bare) note(flow.id, vp.name, step.name, "contrast", `"${t}" sits on the sky with no plate (sky=${probe.sky}) — DESIGN.md §2ax`);
        }
        /* OVERLAP REPORTS, IT DOES NOT FAIL — and that is a judgement about the assertion, not
           about the product. Three scopings were tried on production and each fixed one case by
           breaking another: grouping by container silenced the take-it sheet AND would have
           silenced the pill over the zoom, which is the defect it was built for (it fired 0 on
           build-cold, where that pair lives); a full-viewport modality test missed the leg card
           entirely; asking who buries the control went from 6 findings to 19. A check that cannot
           separate "a modal is over the page" from "a control is over its neighbour" is not ready
           to gate anything, and a noisy gate is worse than none — it teaches people to ignore red,
           which is the whole reason flow-diff exists.
           So the number stays in the report where a person can read it, and emits no finding.
           Promote it when somebody finds the rule; the three that DO have a ground truth — band,
           contrast, glyph — are unaffected. */
        if (probe?.overlap?.length)
          bits.push(`${probe.overlap.length} overlapping control pair(s), informational: ` +
            probe.overlap.slice(0, 4).map(o => `${o.a} over ${o.b} (${o.pct}%)`).join(", "));
        if (probe?.glyphless?.length) {
          bits.push(`**${probe.glyphless.length} icon button(s) drew nothing:** ` + probe.glyphless.join(", "));
          for (const g of probe.glyphless) note(flow.id, vp.name, step.name, "glyph", `${g} has an empty <svg> — an icon name with no entry in that page's P table`);
        }
        if (probe?.map?.drewButInvisible) { bits.push("**map drew but is invisible (D-167)**"); note(flow.id, vp.name, step.name, "map", "tiles painted at opacity 0"); }
        else if (probe?.map?.tiles) bits.push(`map: ${probe.map.tiles} tiles, ${probe.map.opaqueColours} opaque colours`);
        const errs = [...page.pageErrors, ...page.consoleLog];
        if (errs.length) {
          bits.push(`**${errs.length} console error(s):** ` + errs.slice(0, 3).join(" | ").slice(0, 300));
          for (const e of errs.slice(0, 3)) note(flow.id, vp.name, step.name, "error", e.slice(0, 160));
          page.clearErrors();
        }

        report.push(`**${n}. ${step.name}** — ${probe?.controls ?? "?"} controls on screen`);
        if (probe?.text?.length) report.push(`> ${probe.text.slice(0, 3).join(" · ")}`);
        if (bits.length) report.push(bits.map(b => `- ${b}`).join("\n"));
        report.push(`![${step.name}](${png})\n`);
        process.stdout.write(`  ${flow.id} ${vp.name} ${n}/${flow.steps.length} ${ok === false ? "✗" : "·"}\n`);
      }
    }
  }
} finally { await page.close(); }

const byKind = findings.reduce((a, f) => (a[f.kind] = (a[f.kind] || 0) + 1, a), {});
const head = [
  `# Flow run — ${stamp}`,
  ``,
  `\`${BASE}\` · ${flows.length} flow(s) · ${VIEWPORTS.map(v => v.name).join(" and ")}`,
  ``,
  `**${new Set(findings.map(f => [f.flow, f.vp, f.kind, f.text].join('\u0000'))).size} distinct findings** (${findings.length} occurrences)` + (findings.length ? `: ` + Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(", ") : ""),
  ``,
  `**What this cannot tell you:** where somebody hesitated. That is what a moderated cold run —`,
  `one non-designer, watched, building a trip — is for, and no harness replaces it. What is below`,
  `is the mechanical roughness — the things that`,
  `survive being counted.`,
  ``,
];
/* ONE ROW PER DISTINCT FINDING, not one per step it survived into.
   A control that is 4px too short is 4px too short at every step it is on screen, and listing it
   eight times buries the thing that happened once. First step it appeared at, plus a count. */
const uniq = new Map();
for (const f of findings) {
  const key = [f.flow, f.vp, f.kind, f.text].join("\u0000");
  if (uniq.has(key)) uniq.get(key).n++;
  else uniq.set(key, { ...f, n: 1 });
}
if (uniq.size) {
  head.push(`| flow | viewport | first seen at | kind | what | steps |`, `|---|---|---|---|---|---|`);
  for (const f of uniq.values())
    head.push(`| ${f.flow} | ${f.vp} | ${f.step} | ${f.kind} | ${f.text.replace(/\|/g, "/")} | ${f.n} |`);
  head.push(``);
}

/* Machine-readable beside the prose, for test/flow/diff.mjs (§2bu). The report is for a person
   and its shape is load-bearing (CLAUDE.md's quiet form reads the last lines); this is for the
   differ, so nothing above moves. */
writeFileSync(`${outDir}/findings.json`,
  JSON.stringify({ stamp, base: BASE, findings }, null, 2) + "\n");
writeFileSync(`${outDir}/report.md`, head.concat(report).join("\n") + "\n");
console.log(`\n${uniq.size} distinct findings (${findings.length} occurrences) → ${outDir}/report.md`);
for (const [k, v] of Object.entries(byKind)) console.log(`  ${v} ${k}`);
