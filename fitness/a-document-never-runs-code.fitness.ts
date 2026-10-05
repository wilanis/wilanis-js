/**
 * Claim: no package source evaluates a string or loads a module from a path a document could supply.
 * Why: `docs/security-model.md` opens with "a document never runs code": a tree is JSON, no node evaluates a
 *   string, no template calls a function, and `plugins[].from` and `includes[].from` are npm package names, never
 *   paths. That is a property of the TypeScript, not of a tree, so the checker cannot judge it (RFC 0020); and
 *   one `eval` however it is reached, one `Function` with or without `new`, one import of `vm` or one `import` of
 *   a computed path in any package would make the sentence false while every refusal still held. Today the one
 *   computed `import` is the plugin and include loader's, whose argument is a package name `PACKAGE_NAME` has
 *   checked, resolved through `createRequire` from the project's own `node_modules`; that one call is exempt, and
 *   nothing else in its file.
 * Retire when: a document may name code to run, and an RFC that edits the security model's first section says
 *   how. A second loader is not that: it is the violation this claim names, until that page changes first.
 */
import { importsOf, packageDirs, reachesOf, sourceFiles, textOf } from './lib/sources.js';

/** The one computed load the claim allows: the file, the call it makes, and why its name is not a document's. */
const LOADER = {
  file: 'packages/runtime/src/project.ts',
  name: 'import',
  why: 'the plugin and include loader: it imports only a package name PACKAGE_NAME has checked, resolved by createRequire',
};

/** The names whose reach this claim reads: what evaluates a string, and what loads a module. */
const NAMES = ['eval', 'Function', 'vm', 'import', 'require'];

/** The module that runs a string as code, under both the names Node answers it by. */
const VM = ['vm', 'node:vm'];

/** The claim this module holds, and the title the runner gives its test. */
export const claim = 'no package source evaluates a string or loads a module from a path a document could supply';

/** Every file under a package's `src` that imports `vm` or reaches one of the names, with each place it does. */
export const gather = () =>
  packageDirs()
    .flatMap(dir => sourceFiles(`${dir}/src`))
    .map(file => source(file, textOf(file)))
    .filter(({ imports, reaches }) => imports.length + reaches.length > 0);

type Source = ReturnType<typeof gather>[number];
type Found = Source['reaches'][number];

/** Every place a source runs code a document could name, one sentence each, naming the file, the line and the fix. */
export const judge = (files: ReturnType<typeof gather>): string[] => files.flatMap(faultsOf);

const NEVER = "a document never runs code; if this is deliberate, RFC 0020's page changes first";

/** What one file does that runs code: each import of `vm`, and each reach that is not the loader's one call. */
function faultsOf({ file, imports, reaches }: Source): string[] {
  const imported = imports.map(specifier => `${file} imports ${specifier}; ${NEVER}`);
  const reached = reaches
    .filter(reach => !(file === LOADER.file && reach.name === LOADER.name && reach.form === 'call'))
    .flatMap(reach => {
      const spelled = runs(reach);
      return spelled ? [`${file}:${reach.line} ${spelled}; ${NEVER}`] : [];
    });
  return [...imported, ...reached];
}

/** How a reach runs code, as the source spells it, or null where it runs none. */
function runs({ name, form, argument }: Found): string | null {
  const evaluates = EVALUATES[name];
  if (evaluates) return evaluates.forms.includes(form) ? evaluates.says : null;
  return form === 'call' && (name === 'import' || name === 'require') ? loads(name, argument) : null;
}

/** Each name that runs a string as code, the forms of reaching it that do, and how a violation spells it. */
const EVALUATES: Record<string, { forms: Found['form'][]; says: string }> = {
  eval: { forms: ['call', 'property'], says: 'reaches eval' },
  Function: { forms: ['call', 'new'], says: 'calls Function(' },
  vm: { forms: ['member'], says: 'reads vm.' },
};

/** How a load runs code: a name computed rather than written, or `vm` loaded by name. */
function loads(name: string, argument: string | null): string | null {
  if (argument === null) return `calls ${name}( with an argument that is not a string written out`;
  return VM.includes(argument) ? `calls ${name}('${argument}')` : null;
}

/** A file as `gather` reads it: its imports of `vm`, and the places it reaches one of the names. */
function source(file: string, text: string) {
  return {
    file,
    imports: importsOf(text).filter(specifier => VM.includes(specifier)),
    reaches: reachesOf(text).filter(reach => NAMES.includes(reach.name)),
  };
}

/** The proof that the judge bites: each way a source can run a string, and the loader's file beyond its one call. */
export const sabotage = [
  {
    input: [source('packages/core/src/expr.ts', "export const one = eval('1');")],
    violation: `packages/core/src/expr.ts:1 reaches eval; ${NEVER}`,
  },
  {
    input: [source('packages/core/src/expr.ts', "export const one = (0, eval)('1');")],
    violation: `packages/core/src/expr.ts:1 reaches eval; ${NEVER}`,
  },
  {
    input: [source('packages/core/src/expr.ts', "export const one = globalThis.eval('1');")],
    violation: `packages/core/src/expr.ts:1 reaches eval; ${NEVER}`,
  },
  {
    input: [source('packages/runtime/src/tools.ts', "const doc = { path: './x.js' };\nrequire(doc.path);")],
    violation: `packages/runtime/src/tools.ts:2 calls require( with an argument that is not a string written out; ${NEVER}`,
  },
  {
    input: [source('packages/runtime/src/tools.ts', 'export const load = (path: string) => import(path);')],
    violation: `packages/runtime/src/tools.ts:1 calls import( with an argument that is not a string written out; ${NEVER}`,
  },
  {
    input: [source('packages/engine/src/run.ts', "import vm from 'node:vm';\nvm.runInThisContext('1');")],
    violation: `packages/engine/src/run.ts:2 reads vm.; ${NEVER}`,
  },
  {
    input: [source('packages/engine/src/run.ts', "import { runInNewContext } from 'node:vm';\nrunInNewContext('1');")],
    violation: `packages/engine/src/run.ts imports node:vm; ${NEVER}`,
  },
  {
    input: [source('packages/core/src/expr.ts', "export const run = new Function('return 1');")],
    violation: `packages/core/src/expr.ts:1 calls Function(; ${NEVER}`,
  },
  {
    input: [source('packages/core/src/expr.ts', "export const run = Function('return 1')();")],
    violation: `packages/core/src/expr.ts:1 calls Function(; ${NEVER}`,
  },
  {
    input: [source(LOADER.file, "export const one = eval('1');")],
    violation: `${LOADER.file}:1 reaches eval; ${NEVER}`,
  },
];
