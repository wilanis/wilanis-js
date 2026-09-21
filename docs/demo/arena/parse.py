#!/usr/bin/env python3
"""Reduce one agent transcript to the metrics and the timeline the arena page shows.

usage: parse.py <transcript.jsonl> <tree> <out.json>

The transcript is Claude Code's JSONL, in either of its two spellings: the stream `claude -p
--output-format stream-json --verbose` prints, or the session file it writes under ~/.claude/projects.
Both carry one JSON object per line whose `type` is `assistant` or `user`, with `message.content` blocks
(`text`, `tool_use`, `tool_result`) and `message.usage` on an assistant line; the stream ends with a
`result` line. The tree is the finished copy, a git repository whose first commit is the baseline.
Beside <out.json> the agent's final report is written as <out>.report.md, taken from the last text it said.
"""
import collections
import datetime
import json
import re
import subprocess
import sys

# $ per million tokens at API list price, by the model id the transcript records: input, output.
# A cache write costs 1.25 x input, a cache read 0.1 x input. This is the one price table of the harness.
PRICE = {
    'claude-haiku-4-5': (1.00, 5.00),
    'claude-sonnet-5': (2.00, 10.00),
    'claude-opus-5': (5.00, 25.00),
}
CACHE_WRITE = 1.25
CACHE_READ = 0.1
USAGE_KEYS = ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')
REFUSAL = re.compile(r'^([A-Z]\d{3})\s', re.M)
COUNT = re.compile(r'(\d+) refusal\(s\)')
VERDICT = re.compile(r'^(?:ACCEPTED|REJECTED)\b.*$', re.M)
HOOK_BLOCK = 'Stop hook feedback:'
WRITERS = ('Edit', 'Write', 'MultiEdit')


def cost_of(model, usage):
    """The cost at list price of one model's token usage, or None when the model is not in the table."""
    price = next((p for prefix, p in PRICE.items() if (model or '').startswith(prefix)), None)
    if price is None:
        return None
    inp, out = price
    return (usage.get('input_tokens', 0) * inp
            + usage.get('cache_creation_input_tokens', 0) * inp * CACHE_WRITE
            + usage.get('cache_read_input_tokens', 0) * inp * CACHE_READ
            + usage.get('output_tokens', 0) * out) / 1e6


def when(stamp):
    """An ISO timestamp as a datetime, or None."""
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')) if stamp else None


def short(text, limit):
    """The text cut at `limit` characters with a mark, so the page stays readable."""
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + ' …'


def text_of(content):
    """A tool result's content as one string, whether it came as text or as blocks."""
    if isinstance(content, str):
        return content
    return ' '.join(b.get('text', '') for b in content if isinstance(b, dict))


def lines_of(path):
    """Every JSON object in the transcript, in order, skipping blank lines."""
    with open(path, encoding='utf8') as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


class Reading:
    """What one pass over the transcript gathers."""

    def __init__(self, tree):
        self.tree = tree
        self.events = []
        self.tools = collections.Counter()
        self.file_writes = collections.Counter()
        self.checks = []
        self.verdicts = []
        self.hook_blocks = 0
        self.usage_by_message = {}
        self.pending = {}
        self.model = None
        self.first = self.last = None
        self.turns = 0
        self.last_text = None
        self.result = None
        self.streamed = False

    def take(self, obj):
        """Read one transcript line into the gathering."""
        stamp = when(obj.get('timestamp'))
        if stamp:
            self.first = self.first or stamp
            self.last = stamp
        kind = obj.get('type')
        if kind == 'assistant':
            self.assistant(obj['message'], obj.get('timestamp'))
        elif kind == 'user':
            self.user(obj.get('message') or {}, obj.get('timestamp'))
        elif kind == 'result':
            self.result = obj
        elif kind == 'system' and obj.get('subtype') == 'init':
            self.streamed = True

    def assistant(self, message, stamp):
        """An assistant line: its usage, its words and the tools it called."""
        self.model = self.model or message.get('model')
        self.remember_usage(message)
        for block in message.get('content', []):
            if block.get('type') == 'text' and block['text'].strip():
                self.turns += 1
                self.last_text = block['text'].strip()
                self.events.append({'kind': 'say', 'text': self.last_text, 'at': stamp})
            elif block.get('type') == 'tool_use':
                self.tool_use(block, stamp)

    def remember_usage(self, message):
        """One API message spans one line per content block, each repeating the usage: keep the largest per message."""
        usage = message.get('usage') or {}
        kept = self.usage_by_message.setdefault(message.get('id') or id(message), {})
        for key in USAGE_KEYS:
            kept[key] = max(kept.get(key, 0), usage.get(key, 0) or 0)

    def tool_use(self, block, stamp):
        """A tool call: counted by name, remembered for its result, and a file write counted per file."""
        name, inp = block['name'], block.get('input', {})
        self.tools[name] += 1
        self.pending[block['id']] = (name, inp)
        label = inp.get('command') or inp.get('file_path') or inp.get('pattern') or json.dumps(inp)[:200]
        if name in WRITERS and inp.get('file_path'):
            self.file_writes[inp['file_path'].replace(self.tree + '/', '')] += 1
        self.events.append({'kind': 'tool', 'name': name, 'label': label, 'id': block['id'], 'at': stamp})

    def user(self, message, stamp):
        """A user line: the tool results, among them every `wilanis check` the agent read, or a Stop hook's block."""
        content = message.get('content')
        if isinstance(content, str):
            self.hook_blocks += content.startswith(HOOK_BLOCK)
            return
        for block in content or []:
            if block.get('type') == 'tool_result':
                self.tool_result(block, stamp)
            elif block.get('type') == 'text':
                self.hook_blocks += block.get('text', '').startswith(HOOK_BLOCK)

    def tool_result(self, block, stamp):
        """One tool result: its refusal codes, and whether it was a check round."""
        text = text_of(block.get('content'))
        codes = REFUSAL.findall(text)
        count = COUNT.search(text)
        name, inp = self.pending.get(block.get('tool_use_id'), ('?', {}))
        command = inp.get('command', '') if isinstance(inp, dict) else ''
        is_check = 'wilanis check' in command or 'npm run check' in command or bool(count and codes)
        if is_check and (count or 'ok:' in text):
            self.checks.append({'refusals': int(count.group(1)) if count else 0, 'codes': codes, 'at': stamp})
        self.verdicts += [v.strip() for v in VERDICT.findall(text)] if 'accept.sh' in command else []
        self.events.append({'kind': 'result', 'for': block.get('tool_use_id'), 'text': short(text, 1200), 'codes': codes, 'at': stamp})

    def usage(self):
        """The token usage: the result line's total when the run ended, else the sum over the API messages, each once.

        A streamed assistant line carries the usage as it stood when that block was emitted, so a stream cut
        short of its result line sums to a lower bound, and `complete` says so; a session file's last block
        of each message carries the whole figure."""
        if self.result and self.result.get('usage'):
            return {k: self.result['usage'].get(k, 0) for k in USAGE_KEYS}, True
        total = collections.Counter()
        for kept in self.usage_by_message.values():
            total.update(kept)
        return dict(total), not self.streamed

    def duration(self):
        """Wall clock in seconds: from the first and last timestamp, or from the result line when there is none."""
        if self.first and self.last and self.last > self.first:
            return (self.last - self.first).total_seconds()
        if self.result and self.result.get('duration_ms'):
            return self.result['duration_ms'] / 1000
        return None


def git(tree, *args):
    """What git prints in the tree."""
    return subprocess.run(['git', '-C', tree, *args], capture_output=True, text=True).stdout


def churn(tree):
    """Files added and changed against the baseline commit, committed or not, and the lines in the new files."""
    base = git(tree, 'rev-list', '--max-parents=0', 'HEAD').strip()
    baseline_files = set(git(tree, 'ls-tree', '-r', '--name-only', base).split('\n'))
    touched = [f for f in git(tree, 'diff', '--name-only', base).split('\n') if f]
    untracked = [f for f in git(tree, 'ls-files', '--others', '--exclude-standard').split('\n') if f]
    added = sorted(set(untracked) | {f for f in touched if f not in baseline_files})
    changed = sorted(f for f in touched if f in baseline_files)
    added_lines = 0
    for f in added:
        try:
            with open(f'{tree}/{f}', encoding='utf8') as fh:
                added_lines += sum(1 for _ in fh)
        except OSError:
            pass
    return {
        'files_added': added,
        'files_changed': changed,
        'diffstat': git(tree, 'diff', '--shortstat', base).strip(),
        'added_lines_new_files': added_lines,
    }


def main(path, tree, out):
    """Reduce the transcript at `path`, made over `tree`, into `out` and the report beside it."""
    reading = Reading(tree)
    for obj in lines_of(path):
        reading.take(obj)
    usage, complete = reading.usage()
    result = {
        'model': reading.model,
        'started': reading.first.isoformat() if reading.first else None,
        'finished': reading.last.isoformat() if reading.last else None,
        'duration_s': reading.duration(),
        'turns': reading.turns,
        'tool_calls': sum(reading.tools.values()),
        'tools': dict(reading.tools),
        'usage': usage,
        'usage_complete': complete,
        'cost_usd': cost_of(reading.model, usage),
        'cli_cost_usd': (reading.result or {}).get('total_cost_usd'),
        'checks': reading.checks,
        'refusal_rounds': sum(1 for c in reading.checks if c['refusals']),
        'gate_verdicts': reading.verdicts,
        'hook_blocks': reading.hook_blocks,
        'file_writes': dict(reading.file_writes),
        **churn(tree),
        'events': reading.events,
    }
    with open(out, 'w', encoding='utf8') as f:
        json.dump(result, f, indent=1)
    report = (reading.result or {}).get('result') or reading.last_text or '(the agent said nothing)'
    with open(re.sub(r'\.json$', '', out) + '.report.md', 'w', encoding='utf8') as f:
        f.write(report.rstrip() + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('events', 'checks')}, indent=1))


if __name__ == '__main__':
    main(*sys.argv[1:4])
