#!/usr/bin/env python3
"""Render the arena page: one static file, inline CSS, dark mode, phone width, no script.

usage: render.py <runs-dir> <out.html>

Reads, for each model with a <runs>/<model>.json: that file (parse.py), <model>.facts.json (facts.py),
<model>.gate.txt (the gate run again), <model>.validation.txt (the nine curls) and <model>.report.md (the
agent's own report); beside them <runs>/meta.json for the footer when run.sh wrote one. From this directory:
scenario.json, prompt.md, accept.sh, and notes.json when it is written for the same commit as the run.
"""
import datetime
import html
import json
import os
import re
import subprocess
import sys

from tables import fact_rows, metric_rows, note_rows, table

HERE = os.path.dirname(os.path.abspath(__file__))
ORDER = ['haiku', 'sonnet', 'opus']
NAMES = {'haiku': 'Claude Haiku 4.5', 'sonnet': 'Claude Sonnet 5', 'opus': 'Claude Opus 5'}
CODE = re.compile(r'^([A-Z]\d{3})(\s)', re.M)
CSS = """
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --mute:#5c5c5c; --line:#d9d9d9; --pre:#f4f4f2; --mark:#8a3b00; --good:#1e6b34; --bad:#8a1c1c; --warn:#7a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#131313; --fg:#e6e6e6; --mute:#a0a0a0; --line:#333; --pre:#1d1d1d; --mark:#f0a35b; --good:#7fd19a; --bad:#f08a8a; --warn:#e6c35a; } }
* { box-sizing: border-box; } html { background: var(--bg); color: var(--fg); }
body { margin: 0 auto; padding: 1rem 16px 3rem; max-width: 72rem; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { font-size: 1.8rem; line-height: 1.2; margin: 1rem 0 .5rem; }
h2 { font-size: 1.3rem; margin: 2.5rem 0 .5rem; padding-top: 1.5rem; border-top: 1px solid var(--line); }
h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--mute); margin: 1.4rem 0 .3rem; }
p { margin: .5rem 0; }
pre { margin: .5rem 0; padding: .7rem .9rem; background: var(--pre); border: 1px solid var(--line); border-radius: 4px; overflow-x: auto; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
pre b { color: var(--mark); }
code { font: 90% ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .95rem; }
th, td { text-align: left; vertical-align: top; padding: .4rem .6rem; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
thead th { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); }
tbody th { font-weight: 500; color: var(--mute); width: 26%; }
td.good { color: var(--good); } td.bad { color: var(--bad); } td.warn { color: var(--warn); }
.cols { display: grid; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); gap: 1rem; }
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
.col h3 { margin-top: .5rem; }
.say { margin: .6rem 0; padding: .3rem .6rem; border-left: 3px solid var(--line); font-size: .92rem; white-space: pre-wrap; }
.call { font-size: .85rem; margin: .15rem 0; } .call .n { color: var(--mute); display: inline-block; min-width: 2em; } .call .tool { font-weight: 600; }
details { margin: .3rem 0; } summary { cursor: pointer; color: var(--mute); font-size: .85rem; }
details.refused summary { color: var(--mark); }
.timeline { max-height: 40rem; overflow: auto; border: 1px solid var(--line); border-radius: 4px; padding: .5rem .8rem; }
footer { margin-top: 3rem; color: var(--mute); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 1rem; }
"""


def esc(text):
    """Text escaped for HTML."""
    return html.escape(str(text if text is not None else ''))


def pre(text):
    """A <pre> of real output, a refusal code at the start of a line in <b>."""
    return f'<pre>{CODE.sub(lambda m: f"<b>{m.group(1)}</b>{m.group(2)}", esc(text))}</pre>'


def read(path, default=None):
    """A file's text, or the default when it is not there."""
    try:
        with open(path, encoding='utf8') as f:
            return f.read()
    except OSError:
        return default


def read_json(path, default=None):
    """A JSON file, or the default when it is not there."""
    text = read(path)
    return json.loads(text) if text is not None else default


def name_of(model, data):
    """The model's display name: the alias's, or the id the transcript recorded."""
    return NAMES.get(model) or data.get('model') or model


def timeline(data):
    """Every tool call in order, the agent's words between them, each refusing check expandable."""
    out, n = [], 0
    for e in data['events']:
        if e['kind'] == 'say':
            out.append(f'<div class="say">{esc(e["text"])}</div>')
        elif e['kind'] == 'tool':
            n += 1
            out.append(f'<div class="call"><span class="n">{n}</span> <span class="tool">{esc(e["name"])}</span> <code>{esc(e["label"][:300])}</code></div>')
        elif e['kind'] == 'result' and e['codes']:
            out.append(f'<details class="refused"><summary>↳ {len(e["codes"])} refusal line(s): {esc(" ".join(e["codes"]))}</summary>{pre(e["text"])}</details>')
    return '\n'.join(out)


def columns(models, names, body):
    """One column per model, each headed by its name."""
    return f'<div class="cols" style="--n:{len(models)}">' + ''.join(f'<div class="col"><h3>{esc(names[m])}</h3>{body(m)}</div>' for m in models) + '</div>'


def meta_of(runs):
    """The footer's date and commit: meta.json when run.sh wrote one, else today and HEAD."""
    meta = read_json(f'{runs}/meta.json', {})
    if 'commit' not in meta:
        head = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=HERE, capture_output=True, text=True).stdout.strip()
        meta['commit'] = head or 'unknown'
    meta.setdefault('date', datetime.date.today().isoformat())
    meta.setdefault('how', 'each model through `claude -p` with the default effort, one attempt each, no retries')
    return meta


def load(runs):
    """Everything the page is made of, for the models the runs directory holds."""
    models = [m for m in ORDER if os.path.exists(f'{runs}/{m}.json')]
    if not models:
        sys.exit(f'render.py: no <model>.json in {runs}')
    data = {m: read_json(f'{runs}/{m}.json') for m in models}
    meta = meta_of(runs)
    notes = read_json(f'{HERE}/notes.json')
    if notes and (notes.get('for') or {}).get('commit') != meta['commit']:
        notes = None
    return {
        'models': models,
        'names': {m: name_of(m, data[m]) for m in models},
        'data': data,
        'facts': {m: read_json(f'{runs}/{m}.facts.json') for m in models},
        'gates': {m: read(f'{runs}/{m}.gate.txt', '(the gate was not run)') for m in models},
        'validation': {m: read(f'{runs}/{m}.validation.txt', '(not run)') for m in models},
        'reports': {m: read(f'{runs}/{m}.report.md', '(no report)') for m in models},
        'scenario': read_json(f'{HERE}/scenario.json'),
        'prompt': read(f'{HERE}/prompt.md'),
        'gate': read(f'{HERE}/accept.sh'),
        'notes': notes,
        'meta': meta,
    }


def head(page):
    """The page down to the first table: title, thesis, the rule, the setup, the prompt and the gate collapsed."""
    s = page['scenario']
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(s['title'])}</title>
<style>{CSS}</style></head><body>
<h1>{esc(s['title'])}</h1>
<p>{esc(s['thesis'])}</p>
<h3>The rule already in the tree, which the gate reports on and does not judge</h3>
{pre(json.dumps(s['invariant'], indent=2))}
<p>{esc(s['setup'])}</p>
<h3>The prompt, identical for the three, except the directory and the port</h3>
<details><summary>Show the prompt</summary>{pre(page['prompt'])}</details>
<h3>The gate, accept.sh, committed in each copy before the agent arrived</h3>
<details><summary>Show the acceptance test</summary>{pre(page['gate'])}</details>'''


def body(page):
    """The tables and the columns: facts, notes, metrics, verdicts, curls, timelines, reports."""
    models, names, s = page['models'], page['names'], page['scenario']
    parts = [
        '<h2>What each tree says, read by facts.py</h2>',
        f'<p>{esc(s["facts_intro"])}</p>',
        table('Read from the tree against its baseline', fact_rows(page['facts'], models), models, names, 'facts'),
    ]
    if page['notes']:
        parts += ['<h2>What the reviewer read that no script can</h2>', f'<p>{esc(page["notes"]["intro"])}</p>',
                  table('Read by the reviewer', note_rows(page['notes'], models), models, names, 'notes')]
    parts += [
        '<h2>Metrics</h2>',
        '<p>Measured from each transcript (timestamps and token usage as the API reported them, each API message counted once), from <code>git</code> in each copy against the committed baseline, and from the check results the agent read. Cost is at API list price from the table at the top of <code>parse.py</code>: input, output, cache write at 1.25× input, cache read at 0.1× input.</p>',
        table('', metric_rows(page['data'], models), models, names, 'metrics'),
        "<h2>The gate's verdict, run again by the reviewer on each finished tree</h2>",
        columns(models, names, lambda m: pre(page['gates'][m])),
        '<h2>The same nine curls against each result, beside the gate</h2>',
        f'<p>{esc(s["validation_intro"])}</p>',
        columns(models, names, lambda m: pre(page['validation'][m])),
        '<h2>What each did, call by call</h2>',
        "<p>Every tool call in order, the agent's own words between them, and each check that refused, expandable. Nothing is edited; long outputs are cut at 1200 characters.</p>",
        columns(models, names, lambda m: f'<div class="timeline">{timeline(page["data"][m])}</div>'),
        "<h2>Each agent's own report</h2>",
        columns(models, names, lambda m: f'<details><summary>Show the report</summary>{pre(page["reports"][m])}</details>'),
    ]
    return '\n'.join(parts)


def footer(page):
    """The footer: when, against what, and how."""
    meta = page['meta']
    return (f'<footer><p>Runs made on {esc(meta["date"])} against the example of wilanis-js at <code>{esc(meta["commit"])}</code>, '
            f'{esc(meta["how"])}. {esc(page["scenario"]["footer"])}</p></footer></body></html>')


def main(runs, out):
    """Write the page for the runs at `runs` to `out`."""
    page = load(runs)
    with open(out, 'w', encoding='utf8') as f:
        f.write('\n'.join([head(page), body(page), footer(page)]))
    print(f'wrote {out} ({os.path.getsize(out) / 1024:.1f} KB) for {", ".join(page["models"])}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
