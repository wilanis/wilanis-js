/**
 * Claim: a refusal code is never reused.
 * Why: RFC 0019 promises a reader of a refusal that a code names one rule, and that a rule which changes what it
 *   is about takes a new code while the old one is retired and its number never used again. The codes were
 *   string literals spread over the checker, core and the plugins, and nothing recorded which numbers had
 *   shipped: D002, G002 and L004 were skipped with no word on whether they were retired or never used, and the
 *   template, a plugin's port and a library graph all cited an X104 for a rule that shipped as X103.
 *   `docs/refusals/` is now the one inventory, a page per code with its status, and this holds the code to it:
 *   every code a rule makes has a page, a live page's code is made by some rule, and a retired page's code is
 *   made by none. A skipped number has no page and is no violation, since nothing shipped under it.
 * Retire when: the codes are declared in one table the rules make their refusals from, and that table records
 *   what each retired code was, so the pages are no longer where a number's history lives; an RFC says so.
 */
import { basename } from 'node:path';
import { entriesUnder, packageDirs, sourceFiles, textOf } from './lib/sources.js';

const CODE = /'[A-Z]\d{3}'/g;
const PAGE = /^[A-Z]\d{3}\.md$/;
const STATUS = /^- \*\*Status:\*\* (\S+?),?\s/m;

/** Where the pages live, one `<CODE>.md` per code beside the index. */
const PAGES = 'docs/refusals';

/** The claim this module holds, and the title the runner gives its test. */
export const claim = 'a refusal code is never reused';

/** Every code made under a package's `src`, and every page under `docs/refusals/` with the status it spells. */
export const gather = () => ({
  made: [
    ...new Set(packageDirs().flatMap(dir => sourceFiles(`${dir}/src`).flatMap(file => codesIn(textOf(file))))),
  ].sort(),
  pages: entriesUnder(PAGES, ['.md'])
    .filter(file => PAGE.test(basename(file)))
    .map(file => ({ code: basename(file, '.md'), status: STATUS.exec(textOf(file))?.[1] ?? '' })),
});

/** Every code without a page, live page without a rule, and retired code made again, each with its fix. */
export const judge = ({ made, pages }: ReturnType<typeof gather>): string[] => {
  const paged = new Set(pages.map(page => page.code));
  return [
    ...made.filter(code => !paged.has(code)).map(unpaged),
    ...pages.filter(page => page.status === 'live' && !made.includes(page.code)).map(page => unmade(page.code)),
    ...pages.filter(page => page.status === 'retired' && made.includes(page.code)).map(page => reused(page.code)),
  ];
};

/** A code a rule makes that no page records. */
function unpaged(code: string): string {
  return `${code} is made by a rule and has no page; write ${PAGES}/${code}.md; a code without a page cannot be told from a reused one`;
}

/** A page that says its code is live while no rule makes it. */
function unmade(code: string): string {
  return `${PAGES}/${code}.md is live and no rule makes ${code}; mark it retired, never delete it`;
}

/** A page that says its code is retired while a rule makes it again. */
function reused(code: string): string {
  return `${PAGES}/${code}.md is retired and a rule makes ${code} again; ${code} was retired; a number is never reused, take the next of the family`;
}

/** Every refusal code a text spells as a string literal, without its quotes. */
function codesIn(text: string): string[] {
  return [...new Set(text.match(CODE) ?? [])].map(quoted => quoted.replaceAll("'", ''));
}

/** The proof that the judge bites: a code with no page, a live page nothing makes, and a retired code made again. */
export const sabotage = [
  {
    input: { made: ['G001', 'G026'], pages: [{ code: 'G001', status: 'live' }] },
    violation:
      'G026 is made by a rule and has no page; write docs/refusals/G026.md; a code without a page cannot be told from a reused one',
  },
  {
    input: {
      made: ['G001'],
      pages: [
        { code: 'G001', status: 'live' },
        { code: 'L004', status: 'live' },
      ],
    },
    violation: 'docs/refusals/L004.md is live and no rule makes L004; mark it retired, never delete it',
  },
  {
    input: { made: ['X104'], pages: [{ code: 'X104', status: 'retired' }] },
    violation:
      'docs/refusals/X104.md is retired and a rule makes X104 again; X104 was retired; a number is never reused, take the next of the family',
  },
];
