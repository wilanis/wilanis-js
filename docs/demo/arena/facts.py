#!/usr/bin/env python3
"""What a reviewer read off each tree by hand the first time, derived from the tree instead.

usage: facts.py <tree> <out.json> [<gate.txt>]

The tree is a finished copy: a git repository whose first commit is the baseline. From it and that commit:
whether `wilanis check` passes; what the rehearsal says the access rule holds at; the one new trigger's
method, route, policies, refusal map and `out`; whether the access invariant's `over` gained the operation
the trigger fires and whether any invariant's `when` or `requires` changed; whether `EntryView` gained
`pinned`; which bindings meet the new operation; the files added and changed. When <gate.txt> is given the
gate is run again with the trigger's verb and route, its output kept there, and its verdict is a fact too.
"""
import json
import os
import re
import subprocess
import sys

ACCESS_RULE = 'features/monitor/domain/writes-are-for-recorders.invariant.json'
VIEW = 'features/monitor/edge/EntryView.shape.json'
HOLDS = re.compile(r'Writes are for recorders\s+holds at (\d+) trigger\(s\)')


def sh(tree, *args, env=None):
    """What a command prints in the tree, stdout and stderr together."""
    run = subprocess.run(args, cwd=tree, capture_output=True, text=True, env=env)
    return (run.stdout or '') + (run.stderr or '')


def git(tree, *args):
    """What git prints in the tree."""
    return sh(tree, 'git', *args).rstrip('\n')


def wilanis(tree, *args):
    """What `wilanis` prints, run from the tree's own node_modules as `npx wilanis` would."""
    return sh(tree, f'{tree}/node_modules/.bin/wilanis', *args)


def read_json(tree, path):
    """A document of the tree as it is now."""
    with open(f'{tree}/{path}', encoding='utf8') as f:
        return json.load(f)


def baseline_json(tree, base, path):
    """A document of the tree as the baseline commit had it."""
    return json.loads(git(tree, 'show', f'{base}:{path}'))


def files(tree, base):
    """Files added and changed against the baseline, committed or not."""
    baseline = set(git(tree, 'ls-tree', '-r', '--name-only', base).split('\n'))
    touched = [f for f in git(tree, 'diff', '--name-only', base).split('\n') if f]
    untracked = [f for f in git(tree, 'ls-files', '--others', '--exclude-standard').split('\n') if f]
    added = sorted(set(untracked) | {f for f in touched if f not in baseline})
    return added, sorted(f for f in touched if f in baseline)


def canonical(aliases, ref):
    """A reference with the project's aliases expanded, so two spellings of one operation compare equal."""
    for alias, target in aliases.items():
        if ref.startswith(alias + '/'):
            return target + ref[len(alias):]
    return ref


def trigger_facts(tree, added):
    """The one new trigger: its method, route, policies, refusal map, out and the operation it fires."""
    triggers = [f for f in added if f.endswith('.trigger.json')]
    if len(triggers) != 1:
        return {'file': None, 'count': len(triggers)}
    doc = read_json(tree, triggers[0])
    settings = doc.get('settings', {})
    policies = [p if isinstance(p, str) else p.get('policy') for p in doc.get('policies', [])]
    return {
        'file': triggers[0],
        'count': 1,
        'method': settings.get('method'),
        'route': settings.get('route'),
        'policies': policies,
        'refusals': (settings.get('response') or {}).get('refusals'),
        'out': doc.get('out'),
        'fires': (doc.get('fire') or {}).get('run'),
    }


def invariant_facts(tree, base, fires):
    """Did the access rule's over gain the fired operation, and did any invariant's when or requires change."""
    aliases = read_json(tree, 'project.json').get('aliases', {})
    before = baseline_json(tree, base, ACCESS_RULE)
    after = read_json(tree, ACCESS_RULE)
    over_before = {canonical(aliases, o) for o in before['access']['over']}
    over_after = {canonical(aliases, o) for o in after['access']['over']}
    fired = canonical(aliases, fires) if fires else None
    invariants = [f for f in git(tree, 'ls-tree', '-r', '--name-only', base).split('\n') if f.endswith('.invariant.json')]
    changed_rules = []
    for path in invariants:
        was, now = baseline_json(tree, base, path), read_json(tree, path)
        for key in ('holds', 'access'):
            if (was.get(key) or {}).get('when') != (now.get(key) or {}).get('when'):
                changed_rules.append(f'{path}: {key}.when')
            if (was.get(key) or {}).get('requires') != (now.get(key) or {}).get('requires'):
                changed_rules.append(f'{path}: {key}.requires')
    return {
        'over_gained_operation': fired in over_after - over_before if fired else None,
        'over_added': sorted(over_after - over_before),
        'over_removed': sorted(over_before - over_after),
        'rules_changed': changed_rules,
    }


def bindings_facts(tree, fires):
    """Which bindings meet the fired operation, out of every binding that meets its port."""
    if not fires or '#' not in fires:
        return {'bound_in': [], 'of': []}
    port, op = fires.split('#', 1)
    aliases = read_json(tree, 'project.json').get('aliases', {})
    port = canonical(aliases, port)
    paths = [f for f in git(tree, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n') if f.endswith('.binding.json')]
    of, bound = [], []
    for path in paths:
        doc = read_json(tree, path)
        if canonical(aliases, doc.get('port', '')) != port:
            continue
        of.append(path)
        if op in (doc.get('operations') or {}):
            bound.append(path)
    return {'bound_in': bound, 'of': of}


def tree_facts(tree):
    """Whether the tree checks, and what the rehearsal says the access rule holds at."""
    check = wilanis(tree, 'check', '.').strip().split('\n')
    verdict = check[-1] if check else ''
    rehearsal = wilanis(tree, 'rehearse', '.', '--profile', 'local')
    holds = HOLDS.search(rehearsal)
    settled = 'every branch settled' in rehearsal
    return {
        'checks': verdict.startswith('ok:'),
        'check_last_line': verdict,
        'refusals': int(m.group(1)) if (m := re.search(r'(\d+) refusal\(s\)', verdict)) else 0,
        'rehearsal_settled': settled,
        'holds_at': int(holds.group(1)) if holds else None,
    }


def gate(tree, method, route, out):
    """Run the gate again with the trigger's verb and route, keep what it printed, and answer its verdict line."""
    text = sh(tree, 'bash', 'accept.sh', method or 'POST', route or '/monitor/{id}/pin')
    with open(out, 'w', encoding='utf8') as f:
        f.write(text)
    last = [l for l in text.strip().split('\n') if l.startswith(('ACCEPTED', 'REJECTED'))]
    return last[-1] if last else '(no verdict)'


def main(tree, out, gate_out=None):
    """Derive the facts of the tree at `tree` into `out`, running the gate when `gate_out` is given."""
    tree = os.path.abspath(tree)
    base = git(tree, 'rev-list', '--max-parents=0', 'HEAD')
    added, changed = files(tree, base)
    trigger = trigger_facts(tree, added)
    result = {
        **tree_facts(tree),
        'trigger': trigger,
        'invariant': invariant_facts(tree, base, trigger.get('fires')),
        'view_has_pinned': 'pinned' in read_json(tree, VIEW).get('fields', {}),
        'bindings': bindings_facts(tree, trigger.get('fires')),
        'files_added': added,
        'files_changed': changed,
    }
    if gate_out:
        result['gate'] = gate(tree, trigger.get('method'), trigger.get('route'), gate_out)
    with open(out, 'w', encoding='utf8') as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result, indent=1))


if __name__ == '__main__':
    main(*sys.argv[1:4])
