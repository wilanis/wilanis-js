// The page: one static file, inline CSS, no script beyond <details>. Everything
// in a <pre> is what the run printed, escaped and never edited.

/** Escape text for HTML. */
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A <pre> of real output; a refusal code at the start of a line is wrapped in <b>. */
function pre(text, { codes = false } = {}) {
  let body = esc(text);
  if (codes) body = body.replace(/^([A-Z]\d{3})(?=\s)/gm, "<b>$1</b>");
  return `<pre>${body}</pre>`;
}

function part(block) {
  const out = [];
  if (block.text) out.push(`<p>${block.text}</p>`);
  if (block.pre !== undefined) out.push(pre(block.pre, { codes: block.codes }));
  if (block.full !== undefined) {
    out.push(`<details><summary>${esc(block.label ?? "the whole output")}</summary>${pre(block.full, { codes: block.codes })}</details>`);
  }
  return out.join("\n");
}

function section(step) {
  const note = step.note ? `<h3>Note</h3>\n<p>${step.note}</p>` : "";
  return `<section id="step-${step.number}">
<h2><span class="n">${step.number}</span> ${esc(step.title)}</h2>
<h3>What the agent does</h3>
${step.does.map(part).join("\n")}
<h3>What the tree answers</h3>
${step.answers.map(part).join("\n")}
<h3>Why it matters when an agent writes it</h3>
<p>${step.why}</p>
${note}
</section>`;
}

function invariantFigure(inv) {
  return `<figure>
<figcaption><code>${esc(inv.path)}</code> &mdash; caught at <a href="#step-${inv.step}">step ${inv.step}</a></figcaption>
${pre(inv.text)}
</figure>`;
}

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --mute: #5c5c5c; --line: #d9d9d9; --pre: #f4f4f2; --mark: #8a3b00; }
@media (prefers-color-scheme: dark) { :root { --bg: #131313; --fg: #e6e6e6; --mute: #a0a0a0; --line: #333; --pre: #1d1d1d; --mark: #f0a35b; } }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0 auto; padding: 1rem 16px 3rem; max-width: 60rem; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { font-size: 1.8rem; line-height: 1.2; margin: 1rem 0 .5rem; }
h2 { font-size: 1.3rem; margin: 2.5rem 0 .5rem; padding-top: 1.5rem; border-top: 1px solid var(--line); }
h2 .n { display: inline-block; min-width: 1.6em; color: var(--mute); font-variant-numeric: tabular-nums; }
h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--mute); margin: 1.4rem 0 .3rem; }
p { margin: .5rem 0; }
pre { margin: .5rem 0; padding: .7rem .9rem; background: var(--pre); border: 1px solid var(--line); border-radius: 4px; overflow-x: auto; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre b { color: var(--mark); }
code { font: 90% ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
details { margin: .5rem 0; }
summary { cursor: pointer; color: var(--mute); }
.head p.thesis { font-size: 1.1rem; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
@media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
figure { margin: 0; min-width: 0; }
figcaption { font-size: .85rem; color: var(--mute); margin-bottom: .3rem; overflow-wrap: anywhere; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .85rem; color: var(--mute); }
a { color: inherit; }
`;

/** The whole page, from the steps that passed and what they printed. */
export function render({ steps, invariants, meta }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The route written a year later</title>
<style>${CSS}</style>
</head>
<body>
<header class="head">
<h1>The route written a year later</h1>
<p class="thesis">An agent given a one-line task writes a route fast and plausibly; what it lacks is the rule it never read and the consequence it cannot see. In this tree the rules are two sentences a human wrote once, in files of their own, and the compiler holds every document to them before anything runs, answering each miss with a code, the file, the path inside it, and the edit that fixes it. This page is the record of one real run: an agent adds a write route to the example, and every output below is what the tree printed.</p>
<div class="pair">
${invariants.map(invariantFigure).join("\n")}
</div>
</header>
<main>
${steps.map(section).join("\n")}
</main>
<footer>
<p>Generated on ${esc(meta.date)} from <code>${esc(meta.commit)}</code> of the repository by <code>node docs/demo/build.mjs</code>, against a copy of the example at <code>${esc(meta.scratch)}</code> under the <code>local</code> profile. A step's output is shown as printed; a step whose assertion fails stops the build, and no page is written.</p>
</footer>
</body>
</html>
`;
}
