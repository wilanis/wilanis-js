/**
 * The pages under `docs/refusals/` keep the form the index's template gives them (RFC 0019): a page per code,
 * headed by its code, with the four header lines and the four sections, each listed in the index. What a page
 * says is a person's to write and a review's to judge; that it can be found and read the same way is held here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGES = fileURLToPath(new URL('../../../docs/refusals', import.meta.url));
const CODE = /^[A-Z]\d{3}$/;
const HEADER = ['Family', 'Status', 'Made in', 'Proved by'];
const SECTIONS = ['Refuses when', 'Example', 'Fix', 'History'];

const read = (name: string) => readFileSync(join(PAGES, name), 'utf8');
const pages = () =>
  readdirSync(PAGES)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .map(name => ({ code: name.replace(/\.md$/, ''), lines: read(name).split('\n') }));

/** The first heading of a page, and the header lines right after it, a wrapped line joined to the one it continues. */
function head(lines: string[]): { heading: string; header: string[] } {
  const body = lines.filter(line => line.trim() !== '');
  const joined = body.reduce<string[]>((out, line) => {
    if (line.startsWith('  ') && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
    return out;
  }, []);
  return { heading: joined[0] ?? '', header: joined.slice(1, 1 + HEADER.length) };
}

/** The second-level headings of a page, in order. */
const sections = (lines: string[]) => lines.filter(line => line.startsWith('## ')).map(line => line.slice(3));

/** The codes the index's table links to a page, in the order it lists them. */
const indexed = () => [...read('README.md').matchAll(/^\| \[([A-Z]\d{3})\]\(\1\.md\) \|/gm)].map(match => match[1]);

describe('the refusal pages', () => {
  it('are named for a code, and there is at least one', () => {
    const names = pages().map(page => page.code);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(code => !CODE.test(code))).toEqual([]);
  });

  it('are headed by their own code, then Family, Status, Made in and Proved by', () => {
    for (const { code, lines } of pages()) {
      const { heading, header } = head(lines);
      expect(heading, code).toBe(`# ${code}`);
      expect(
        header.map(line => /^- \*\*([^*]+):\*\* \S/.exec(line)?.[1]),
        code,
      ).toEqual(HEADER);
      expect(header[0], code).toMatch(new RegExp(`^- \\*\\*Family:\\*\\* ${code[0]} -- `));
      expect(header[1], code).toMatch(/^- \*\*Status:\*\* (live|retired), since \d+\.\d+\.\d+/);
    }
  });

  it('hold Refuses when, Example, Fix and History, in that order and nothing else', () => {
    for (const { code, lines } of pages()) expect(sections(lines), code).toEqual(SECTIONS);
  });

  it('are each listed in the index once, and the index lists no code without a page', () => {
    const listed = indexed();
    const written = pages()
      .map(page => page.code)
      .sort();
    expect([...listed].sort()).toEqual(written);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
