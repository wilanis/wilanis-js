/**
 * Claim: every refusal code the security model cites is one the checker or a plugin makes, and every line under Guaranteed cites at least one.
 * Why: `docs/security-model.md` says a line under *Guaranteed by the checker* is proved of every tree `wilanis
 *   check` accepts by the refusal codes it names (RFC 0020). A promise has to fall when its rule goes, so a code
 *   no rule makes is a line that promises what nothing holds; a line that names no code is a hope; and a code a
 *   rule makes that no line cites is a rule the page does not account for -- the direction RFC 0020's own draft
 *   missed, where D007 was made and cited nowhere through a full review. The codes made are read as
 *   `every-refusal-code-is-proved-by-a-sabotage` reads them: a string literal under a package's `src`.
 * Retire when: the page states its guarantees some way other than by citing refusal codes, and an RFC says how.
 */
import { packageDirs, sourceFiles, textOf } from './lib/sources.js';

const PAGE = 'docs/security-model.md';
const GUARANTEED = 'Guaranteed by the checker';
const MADE = /'[A-Z]\d{3}'/g;
const CITED = /\[([A-Z]\d{3})\]\(refusals\//g;

/** The claim this module holds, and the title the runner gives its test. */
export const claim =
  'every refusal code the security model cites is one the checker or a plugin makes, and every line under Guaranteed cites at least one';

/** Every code made under a package's `src`, and every line of the page with the section it sits under. */
export const gather = () => ({
  made: [...new Set(packageDirs().flatMap(dir => sourceFiles(`${dir}/src`).flatMap(madeIn)))].sort(),
  lines: linesOf(textOf(PAGE)),
});

/** Every refusal code a source file spells as a string literal, without its quotes. */
function madeIn(file: string): string[] {
  return (textOf(file).match(MADE) ?? []).map(quoted => quoted.replaceAll("'", ''));
}

/** The page's list items, each as the line it starts on, the section it sits under, and the codes it cites. */
function linesOf(text: string): { at: number; section: string; codes: string[] }[] {
  const items: { at: number; section: string; codes: string[] }[] = [];
  let section = '';
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    if (line.startsWith('- ')) items.push({ at: index + 1, section, codes: [] });
    const item = items.at(-1);
    if (item && (line.startsWith('- ') || line.startsWith('  '))) item.codes.push(...citedIn(line));
  });
  return items;
}

/** Every code a line of the page cites, as the link to its refusal page. */
function citedIn(line: string): string[] {
  return [...line.matchAll(CITED)].map(match => match[1] ?? '');
}

/** Every way the page and the rules disagree, one sentence each, naming the line or the code and the fix. */
export const judge = ({ made, lines }: ReturnType<typeof gather>): string[] => {
  const cited = new Set(lines.flatMap(line => line.codes));
  return [
    ...lines.flatMap(({ at, codes }) =>
      codes
        .filter(code => !made.includes(code))
        .map(code => `${PAGE}:${at} cites ${code}, which no rule makes; ${GONE}`),
    ),
    ...made
      .filter(code => !cited.has(code))
      .map(code => `${code} is made by a rule and cited by no line of ${PAGE}; ${UNACCOUNTED}`),
    ...lines
      .filter(({ section, codes }) => section === GUARANTEED && codes.length === 0)
      .map(({ at }) => `${PAGE}:${at} is a line under ${GUARANTEED} that cites no code; ${HOPE}`),
  ];
};

const GONE = 'the rule is gone: remove the line or say which code holds it now';
const UNACCOUNTED =
  'a rule the page does not account for: add it to the line it holds, or say why it guarantees nothing';
const HOPE = 'a guarantee names the code that proves it';

/** The proof that the judge bites: a page citing a code no rule makes, a code no line cites, a line with none. */
export const sabotage = [
  {
    input: { made: ['L001'], lines: [{ at: 3, section: GUARANTEED, codes: ['L001', 'L099'] }] },
    violation: `${PAGE}:3 cites L099, which no rule makes; ${GONE}`,
  },
  {
    input: { made: ['D007', 'L001'], lines: [{ at: 3, section: GUARANTEED, codes: ['L001'] }] },
    violation: `D007 is made by a rule and cited by no line of ${PAGE}; ${UNACCOUNTED}`,
  },
  {
    input: {
      made: ['L001'],
      lines: [...linesOf(`## ${GUARANTEED}\n\n- A graph is acyclic. [[L001](refusals/L001.md)]\n- A hope.\n`)],
    },
    violation: `${PAGE}:4 is a line under ${GUARANTEED} that cites no code; ${HOPE}`,
  },
];
