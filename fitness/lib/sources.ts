/**
 * Reading this repository's TypeScript as text. A fitness function judges the source a pull request writes,
 * never the `dist` a build produces, so every reader here parses a file with Babel's parser and answers one
 * question about it: which modules it imports, what it exports, and whether each export says what it answers.
 * The node types are derived from the parser's own return type, so `@babel/parser` is the only dependency.
 */
import { readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';

type Program = ReturnType<typeof parse>['program'];
type Statement = Program['body'][number];
type Named = Extract<Statement, { type: 'ExportNamedDeclaration' }>;
type Klass = Extract<Statement, { type: 'ClassDeclaration' }>;
type Vars = Extract<Statement, { type: 'VariableDeclaration' }>;
type Method = Extract<Klass['body']['body'][number], { type: 'ClassMethod' }>;
type Key = Method['key'];
type Commented = { leadingComments?: ReadonlyArray<{ type: string }> | null };

/** Every `.ts` file under a directory, repository-relative and sorted, with declaration files left out. */
export function sourceFiles(dir: string): string[] {
  return entriesUnder(dir, ['.ts']).filter(file => !file.endsWith('.d.ts'));
}

/** A repository file's text, read as UTF-8. */
export function textOf(file: string): string {
  return readFileSync(file, 'utf8');
}

/** The top-level statements of a file's text, with the comments that lead each one attached. */
function statementsOf(text: string): Statement[] {
  return parse(text, { sourceType: 'module', plugins: ['typescript'], attachComment: true }).program.body;
}

/** The module specifiers a file's text imports or re-exports, in source order, static strings only. */
export function importsOf(text: string): string[] {
  return statementsOf(text).flatMap(specifierOf);
}

/** One import statement: the module it names, and the names it binds from it. */
export interface NamedImport {
  from: string;
  names: string[];
}

/**
 * Every import statement of a file's text as the module it names and the names it binds. A claim asks this
 * rather than `importsOf` when the source matters: two packages may export one name for different things, so
 * a rule about `readAll` from `@wilanis/core` must not judge the engine's own `readAll`.
 */
export function namedImportsOf(text: string): NamedImport[] {
  return statementsOf(text).flatMap(statement =>
    statement.type === 'ImportDeclaration' ? [{ from: statement.source.value, names: boundNames(statement) }] : [],
  );
}

/** The names one import statement binds, as the exporting module spells them; a default or a namespace binds none. */
function boundNames(statement: Extract<Statement, { type: 'ImportDeclaration' }>): string[] {
  return statement.specifiers.flatMap(specifier =>
    specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' ? [specifier.imported.name] : [],
  );
}

/** An exported declaration: the name it binds, and whether a doc comment leads it. */
export interface Export {
  name: string;
  documented: boolean;
}

/** Every function, arrow constant, class and public method a file's text exports, each with its doc comment. */
export function exportsOf(text: string): Export[] {
  return statementsOf(text).flatMap(statement =>
    statement.type === 'ExportNamedDeclaration' ? exportedNames(statement) : [],
  );
}

/** The one module specifier a statement names, or nothing where it names none. */
function specifierOf(statement: Statement): string[] {
  const imports = statement.type === 'ImportDeclaration';
  const reexports = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration';
  const source = imports || reexports ? statement.source : null;
  return source ? [source.value] : [];
}

/** The callable names an `export` statement binds, each with whether a doc comment leads it. */
function exportedNames(statement: Named): Export[] {
  const declaration = statement.declaration;
  if (!declaration) return [];
  const documented = hasDoc(statement);
  if (declaration.type === 'FunctionDeclaration') return [{ name: nameOf(declaration.id), documented }];
  if (declaration.type === 'ClassDeclaration') return classExports(declaration, documented);
  if (declaration.type === 'VariableDeclaration') return arrowExports(declaration, documented);
  return [];
}

/** The class itself and every public method it declares, each documented by the comment that leads it. */
function classExports(declaration: Klass, documented: boolean): Export[] {
  const name = nameOf(declaration.id);
  const methods = declaration.body.body.flatMap(member =>
    member.type === 'ClassMethod' && member.accessibility !== 'private' && member.kind !== 'constructor'
      ? [{ name: `${name}.${memberName(member.key)}`, documented: hasDoc(member) }]
      : [],
  );
  return [{ name, documented }, ...methods];
}

/** Every arrow-function constant an exported `const` binds; a plain value export answers nothing. */
function arrowExports(declaration: Vars, documented: boolean): Export[] {
  return declaration.declarations.flatMap(declarator => {
    const init = declarator.init?.type;
    const isFunction = init === 'ArrowFunctionExpression' || init === 'FunctionExpression';
    return isFunction && declarator.id.type === 'Identifier' ? [{ name: declarator.id.name, documented }] : [];
  });
}

/** Whether a block comment leads a node, which is how this repository says what a function answers. */
function hasDoc(node: Commented): boolean {
  return (node.leadingComments ?? []).some(comment => comment.type === 'CommentBlock');
}

/** The name an identifier binds, or `<anonymous>` where a declaration binds none. */
function nameOf(id: { name: string } | null | undefined): string {
  return id?.name ?? '<anonymous>';
}

/** The name a class member's key holds, whether written plainly or as a string. */
function memberName(key: Key): string {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return '<computed>';
}

/**
 * Every identifier and every string literal a file's text holds, comments excluded, so a claim can hold a
 * vocabulary rather than an import. A word in a comment is a reader explaining the design and not the code
 * doing it, which is why a file may say in prose what it may not spell in an identifier.
 */
export function wordsOf(text: string): string[] {
  const found: string[] = [];
  walk(parse(text, { sourceType: 'module', plugins: ['typescript'] }).program, node => {
    if (node.type === 'Identifier' && node.name !== undefined) found.push(node.name);
    else if (node.type === 'StringLiteral' && node.value !== undefined) found.push(node.value);
    else if (node.type === 'TSPropertySignature' || node.type === 'ObjectProperty') keyWord(node, found);
  });
  return found;
}

/** A property's key as a word, since a member named for the guard's business is spelled here and nowhere else. */
function keyWord(node: object, found: string[]): void {
  const key = (node as { key?: { type: string; name?: string; value?: string } }).key;
  if (key?.type === 'Identifier' && key.name) found.push(key.name);
  if (key?.type === 'StringLiteral' && key.value) found.push(key.value);
}

/**
 * One place a file's text calls, constructs or reads a member of a bare name, or reads a property by name, with
 * the string it is handed where that string is written out in the source.
 */
export interface Reach {
  name: string;
  form: 'call' | 'new' | 'member' | 'property';
  argument: string | null;
  line: number;
}

/** A parsed node as `reachesOf` reads it: only the fields a call, a construction or a member read carries. */
interface Loose {
  type: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  callee?: Loose;
  object?: Loose;
  property?: Loose;
  source?: Loose;
  arguments?: Loose[];
  expressions?: Loose[];
  quasis?: { value: { cooked?: string | null } }[];
  loc?: { start: { line: number } } | null;
}

/**
 * Every call, construction and member read a file's text makes of a bare name, and every property it reads by
 * name, comments and the contents of strings left out: `eval(x)` and `(0, eval)(x)` are calls of `eval`,
 * `new Function(x)` a construction of `Function`, `vm.run` a member read of `vm`, `globalThis.eval` a property
 * read of `eval`, `import(x)` a call of `import`, and a call of what `createRequire(...)` answers a call of
 * `require`. `argument` is the first argument where it is a string written out whole, and null otherwise.
 */
export function reachesOf(text: string): Reach[] {
  const found: Reach[] = [];
  walk(parse(text, { sourceType: 'module', plugins: ['typescript'] }).program, node => {
    found.push(...reachOf(node as Loose));
  });
  return found;
}

/** The reaches one node makes, or nothing where it is no call, construction or member read. */
function reachOf(node: Loose): Reach[] {
  const line = node.loc?.start.line ?? 0;
  if (node.type === 'ImportExpression') return [{ name: 'import', form: 'call', argument: fixedOf(node.source), line }];
  if (node.type === 'MemberExpression') return memberReaches(node, line);
  const form = FORMS[node.type];
  const name = bareName(node.callee);
  return form && name ? [{ name, form, argument: fixedOf(node.arguments?.[0]), line }] : [];
}

const FORMS: Record<string, Reach['form']> = { CallExpression: 'call', NewExpression: 'new' };

/** What a member read reaches: the bare name it reads a member of, and the property it reads by name. */
function memberReaches(node: Loose, line: number): Reach[] {
  const object = bareName(node.object);
  const property = node.computed ? fixedOf(node.property) : (node.property?.name ?? null);
  return [
    ...(object ? [{ name: object, form: 'member' as const, argument: null, line }] : []),
    ...(property ? [{ name: property, form: 'property' as const, argument: null, line }] : []),
  ];
}

/**
 * The name a callee or an object spells: an identifier, `import`, the last of a comma expression, or `require`
 * for what `createRequire` answers.
 */
function bareName(node: Loose | undefined): string | null {
  if (node?.type === 'Identifier') return node.name ?? null;
  if (node?.type === 'Import') return 'import';
  if (node?.type === 'SequenceExpression') return bareName(node.expressions?.at(-1));
  const required = node?.type === 'CallExpression' && bareName(node.callee) === 'createRequire';
  return required ? 'require' : null;
}

/** The string an argument is where it is written out whole, so what it names is fixed in the source; else null. */
function fixedOf(node: Loose | undefined): string | null {
  if (node?.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  const plain = node?.type === 'TemplateLiteral' && node.expressions?.length === 0;
  return plain ? (node?.quasis?.[0]?.value.cooked ?? null) : null;
}

/** Every node of a parsed tree, comments left out because the parser keeps them off the tree by default. */
function walk(node: unknown, visit: (node: { type: string; name?: string; value?: string }) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const typed = node as { type?: string };
  if (typeof typed.type === 'string') visit(node as { type: string; name?: string; value?: string });
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc') walk(child, visit);
  }
}

/** Two directory entries in name order, for a stable walk over a file system that promises none. */
function byName(one: { name: string }, other: { name: string }): number {
  return one.name < other.name ? -1 : 1;
}

/** Every fitness function in the suite, so a claim about the suite's own shape reads the directory it is in. */
export function fitnessFiles(): string[] {
  return sourceFiles('fitness').filter(file => file.endsWith('.fitness.ts'));
}

/** The bare package a specifier names -- `@scope/name` or `name` -- or null where it is relative. */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? null);
}

/**
 * Every package under `packages/`, repository-relative and sorted, so a claim reads the workspace. A
 * directory holding no `package.json` is not a package: build output is gitignored, so a `dist/` left by a
 * branch that had the package outlives a switch to one that does not, and a reader that took it for a
 * package took the whole suite down with it.
 */
export function packageDirs(): string[] {
  return readdirSync('packages', { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `packages/${entry.name}`)
    .filter(dir => fileExists(`${dir}/package.json`))
    .sort();
}

/** Whether a file is there, for a claim that asks what a package ships rather than what it says. */
export function fileExists(path: string): boolean {
  return statOf(path)?.isFile() ?? false;
}

/** Whether a directory is there, for a claim about where something lives. */
export function dirExists(path: string): boolean {
  return statOf(path)?.isDirectory() ?? false;
}

/** What the file system says about a path, or null where it says nothing. */
function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** The names a directory holds, sorted, or nothing where the directory is not there. */
export function entriesOf(dir: string): string[] {
  if (!dirExists(dir)) return [];
  return readdirSync(dir).slice().sort();
}

/** Every file under a directory whose name ends in one of these suffixes, repository-relative and sorted. */
export function entriesUnder(dir: string, suffixes: string[]): string[] {
  if (!dirExists(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...entriesUnder(path, suffixes));
    else if (suffixes.some(suffix => entry.name.endsWith(suffix))) found.push(path);
  }
  return found;
}
