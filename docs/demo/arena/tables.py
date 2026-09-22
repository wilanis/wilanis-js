#!/usr/bin/env python3
"""The three tables of the arena page, one column per model: the facts facts.py derived, the reviewer's notes,
and the metrics parse.py reduced. Each row is (label, {model: (text, mark)}); render.py lays them out."""
import html
import re


def esc(text):
    """Text escaped for HTML."""
    return html.escape(str(text if text is not None else ''))


def fmt_dur(seconds):
    """Seconds as `N min SS s`."""
    return f'{int(seconds // 60)} min {int(seconds % 60):02d} s' if seconds else '–'


def fmt_k(count):
    """A token count, in thousands past ten thousand."""
    return f'{count / 1000:.0f}k' if count >= 10000 else f'{count:,}'


def base(ref):
    """A document reference as its file name without the kind suffix, for a table cell."""
    return re.sub(r'\.(policy|shape|trigger)\.json$', '', str(ref or '').rsplit('/', 1)[-1])


def table(head, rows, models, names, cls):
    """A table with one column per model; a row is (label, {model: (text, mark)})."""
    out = [f'<table class="{cls}"><thead><tr><th>{esc(head)}</th>' + ''.join(f'<th>{esc(names[m])}</th>' for m in models) + '</tr></thead><tbody>']
    for label, cells in rows:
        out.append(f'<tr><th>{esc(label)}</th>' + ''.join(f'<td class="{esc(cells[m][1])}">{esc(cells[m][0])}</td>' for m in models) + '</tr>')
    out.append('</tbody></table>')
    return '\n'.join(out)


def yes_no(flag, good_when=True):
    """A boolean as a cell, green when it is what the tree wanted."""
    if flag is None:
        return ('–', '')
    return ('yes' if flag else 'no', 'good' if flag == good_when else 'bad')


def fact_rows(facts, models):
    """The facts table's rows, one cell per model, derived and never read by hand."""
    def each(f):
        return {m: f(facts[m]) for m in models}

    def gate(x):
        verdict = x.get('gate') or '(not run)'
        return (verdict, 'good' if verdict.startswith('ACCEPTED') else 'bad')

    def checks(x):
        return (x['check_last_line'], 'good' if x['checks'] else 'bad')

    def holds(x):
        return (f"{x['holds_at']} trigger(s), from 5" if x['holds_at'] is not None else 'no rehearsal: the tree does not check', '' if x['holds_at'] is not None else 'bad')

    def trigger(x):
        t = x['trigger']
        return (f"{t['method']} {t['route']}" if t.get('file') else f"{t['count']} new trigger(s)", '' if t.get('file') else 'bad')

    def refusals(x):
        r = x['trigger'].get('refusals') or {}
        return (', '.join(f'{k} {v}' for k, v in r.items()) or '–', '')

    def over(x):
        inv = x['invariant']
        gained = inv['over_gained_operation']
        text = 'yes: ' + ', '.join(inv['over_added']) if gained else 'no'
        if inv['over_removed']:
            text += '; removed ' + ', '.join(inv['over_removed'])
        return (text, 'bad' if inv['over_removed'] else '')

    def rules(x):
        changed = x['invariant']['rules_changed']
        return (', '.join(changed) if changed else 'none', 'bad' if changed else 'good')

    def bindings(x):
        b = x['bindings']
        return (f"{len(b['bound_in'])} of {len(b['of'])}", 'good' if b['of'] and len(b['bound_in']) == len(b['of']) else 'bad')

    return [
        ('Did the gate accept the work, run again by the reviewer', each(gate)),
        ('Does wilanis check pass', each(checks)),
        ('Does every rehearsed branch settle', each(lambda x: yes_no(x['rehearsal_settled']))),
        ("The rehearsal's Writes are for registrars holds at", each(holds)),
        ('The new trigger', each(trigger)),
        ('Policies it attaches, in order', each(lambda x: (', '.join(base(p) for p in x['trigger'].get('policies') or []) or 'none', ''))),
        ('Its refusal map', each(refusals)),
        ('Its out', each(lambda x: (base(x['trigger'].get('out')) or '–', ''))),
        ('The operation it fires', each(lambda x: (str(x['trigger'].get('fires') or '–').split('/')[-1], ''))),
        ("Did the access rule's over gain that operation", each(over)),
        ("Did any invariant's when or requires change", each(rules)),
        ('Did CustomerView gain active, so a client can see what it toggled', each(lambda x: yes_no(x['view_has_active']))),
        ('Bindings of the port that meet the operation', each(bindings)),
        ('Files added', each(lambda x: ('\n'.join(x['files_added']) or 'none', ''))),
        ('Files changed', each(lambda x: ('\n'.join(x['files_changed']) or 'none', ''))),
    ]


def metric_rows(data, models):
    """The metrics table's rows from what parse.py reduced."""
    def each(f):
        return {m: (f(data[m]), '') for m in models}

    def bound(d, text):
        """A figure prefixed with `at least` when the transcript ended without its result line."""
        return text if d.get('usage_complete', True) else f'at least {text} (the run was cut short)'

    def cost(d):
        list_price = f"${d['cost_usd']:.2f}" if d.get('cost_usd') is not None else '– (model not in the price table)'
        return bound(d, list_price + (f" (the CLI said ${d['cli_cost_usd']:.2f})" if d.get('cli_cost_usd') else ''))

    return [
        ('Wall clock', each(lambda d: fmt_dur(d['duration_s']))),
        ('Tool calls', each(lambda d: str(d['tool_calls']))),
        ('  of which Bash / Read / Edit / Write', each(lambda d: ' / '.join(str(d['tools'].get(t, 0)) for t in ('Bash', 'Read', 'Edit', 'Write')))),
        ('Assistant turns with text', each(lambda d: str(d['turns']))),
        ('Check rounds with refusals', each(lambda d: str(d['refusal_rounds']))),
        ('Refusals seen, total', each(lambda d: str(sum(c['refusals'] for c in d['checks'])))),
        ('Distinct refusal codes met', each(lambda d: ' '.join(sorted({c for ch in d['checks'] for c in ch['codes']})) or '–')),
        ('Gate verdicts seen, in order', each(lambda d: '\n'.join(d.get('gate_verdicts') or []) or 'the agent never ran the gate')),
        ('Stops blocked by the hook', each(lambda d: str(d.get('hook_blocks', 0)))),
        ('Files added / changed', each(lambda d: f"{len(d['files_added'])} / {len(d['files_changed'])}")),
        ('Lines in new files', each(lambda d: str(d['added_lines_new_files']))),
        ('Diff against the baseline', each(lambda d: d['diffstat'] or 'none')),
        ('Rewrites of one file through Edit or Write, max (0 when files were written from the shell)', each(lambda d: str(max(d['file_writes'].values()) if d['file_writes'] else 0))),
        ('Output tokens', each(lambda d: bound(d, fmt_k(d['usage'].get('output_tokens', 0))))),
        ('Input tokens, uncached', each(lambda d: fmt_k(d['usage'].get('input_tokens', 0)))),
        ('Cache writes / reads', each(lambda d: f"{fmt_k(d['usage'].get('cache_creation_input_tokens', 0))} / {fmt_k(d['usage'].get('cache_read_input_tokens', 0))}")),
        ('Cost at API list price', each(cost)),
    ]


def note_rows(notes, models):
    """The reviewer's notes as rows, when notes.json speaks of this run."""
    return [(q['question'], {m: (q['answers'].get(m, {}).get('text', '–'), q['answers'].get(m, {}).get('mark', '')) for m in models}) for q in notes['questions']]
