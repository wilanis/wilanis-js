import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { init } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'wilanis-init-'));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('wilanis init', () => {
  it('writes CLAUDE.md, the hooks and the graphs skill, keeps what exists, and says which', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# mine\n');
    const lines = init(dir);
    const skill = join(dir, '.claude', 'skills', 'wilanis-graphs', 'SKILL.md');
    expect(lines).toEqual([
      `kept ${join(dir, 'CLAUDE.md')}`,
      `wrote ${join(dir, '.claude', 'settings.json')}`,
      `wrote ${skill}`,
    ]);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# mine\n');
    expect(read(join(dir, '.claude', 'settings.json')).hooks.Stop).toBeDefined();
    // a second run changes nothing
    expect(init(dir).every(line => line.startsWith('kept '))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the skill opens with its frontmatter, names its triggers, and carries the rule, the shape and the refusals', () => {
    const dir = tmp();
    init(dir);
    const text = readFileSync(join(dir, '.claude', 'skills', 'wilanis-graphs', 'SKILL.md'), 'utf8');
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter![1]).toMatch(/^name: wilanis-graphs$/m);
    expect(frontmatter![1]).toMatch(/^description: /m);
    for (const trigger of ['writing a graph', 'a switch', 'changing', 'load, make, keep', 'G004', 'G008', 'I007'])
      expect(frontmatter![1]).toContain(trigger);
    // the body: the dataflow rule, the load-make-keep pair and the read-decide-write shape over the store, and the
    // refusals they meet; graphs-skill.test.ts holds the graphs it writes out to check
    expect(text).toContain('A switch chooses who answers, not who runs');
    expect(text).toContain('@std/object.port.json#merge');
    expect(text).toContain('"record": "{{in}}"');
    expect(text).toContain('@storage/store.port.json#get');
    for (const code of ['G004', 'G008', 'G009', 'I007', 'I008', 'L016']) expect(text).toContain(`**${code}**`);
    rmSync(dir, { recursive: true, force: true });
  });
});
