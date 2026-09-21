/**
 * `wilanis init`: the files an agent working in a tree starts from, copied from the runtime's templates.
 * The templates directory mirrors the tree it writes -- `CLAUDE.md`, `dot-claude/settings.json`,
 * `dot-claude/skills/<name>/SKILL.md` -- and a `dot-` prefix stands for a leading dot, since a directory
 * named `.claude` would be hidden from the package's `files`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where a template's entry lands in the tree: the same name, with a `dot-` prefix read as a leading dot. */
const placed = (name: string) => name.replace(/^dot-/, '.');

/**
 * wilanis init: write the agent's CLAUDE.md, hooks and skills into a tree from the runtime's templates,
 * walking nested directories. A file that exists is kept, never overwritten. Answers one line per file, in
 * path order: `wrote <path>` or `kept <path>`.
 */
export function init(
  root: string,
  templates = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates'),
): string[] {
  const out: string[] = [];
  const put = (from: string, to: string) => {
    if (existsSync(to)) {
      out.push(`kept ${to}`);
      return;
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    out.push(`wrote ${to}`);
  };
  const walk = (from: string, to: string) => {
    for (const name of readdirSync(from).sort()) {
      const source = join(from, name);
      const target = join(to, placed(name));
      if (statSync(source).isDirectory()) walk(source, target);
      else put(source, target);
    }
  };
  walk(templates, root);
  return out;
}
