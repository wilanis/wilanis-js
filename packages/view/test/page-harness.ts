/**
 * The page's own functions, lifted from its source and run over a stand-in for the DOM: the page is one static
 * file with no build step, so a test reads what a function draws without a browser. A stand-in keeps its tag,
 * class, text and children, and a link the path it opens, enough to read what the page says and where it links.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The page, as the viewer serves it. */
export const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));

/** A stand-in for one element of the page: its tag, class, text and children, enough to read what it says. */
export interface Drawn {
  tag: string;
  cls?: string | null;
  text?: string;
  path?: string;
  node?: string;
  children: Drawn[];
  appendChild(child: Drawn): Drawn;
}

/** One stand-in element, whose appendChild answers the child it was handed, as the DOM's does. */
export const drawn = (fields: Partial<Drawn>): Drawn => {
  const one: Drawn = {
    tag: '',
    children: [],
    ...fields,
    appendChild: child => {
      one.children.push(child);
      return child;
    },
  };
  return one;
};

/** The helpers the lifted functions call, drawing stand-ins rather than elements. */
const HELPERS = {
  el: (tag: string, cls?: string | null, text?: string) => drawn({ tag, cls, text }),
  frag: (...nodes: (string | Drawn)[]) =>
    drawn({ children: nodes.map(one => (typeof one === 'string' ? drawn({ text: one }) : one)) }),
  link: (path: string, text?: string) => drawn({ tag: 'a', path, text: text ?? path }),
  nodeLink: (graph: string, node: string, text: string) => drawn({ tag: 'a', path: graph, node, text }),
  badge: (kind: string) => drawn({ tag: 'span', text: kind }),
  SEP: ' › ',
};

/** Everything one stand-in says, its children's words in order after its own. */
export const words = (one: Drawn): string => [one.text ?? '', ...one.children.map(words)].join('');

/** The page's functions of these names, lifted from its source and bound to the stand-in helpers. */
export async function lifted(...names: string[]): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const page = await readFile(PAGE, 'utf8');
  const sources = names.map(name => {
    const found = page.match(
      new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}|function ${name}\\([^)]*\\) \\{[^\\n]*\\}`),
    );
    if (!found) throw new Error(`no function ${name} on the page`);
    return found[0];
  });
  const body = `${sources.join('\n')}; return { ${names.join(', ')} };`;
  return new Function(...Object.keys(HELPERS), body)(...Object.values(HELPERS));
}
