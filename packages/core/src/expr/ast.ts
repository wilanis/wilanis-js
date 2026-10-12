/**
 * The one expression grammar, used by switch rules. Deliberately small and statically typed against the
 * node's inputs: has(path), comparisons, membership, containment, && || !, len(x), literals, paths.
 *
 *   expr := or ; or := and ('||' and)* ; and := unary ('&&' unary)* ; unary := '!' unary | cmp
 *   cmp  := primary (('=='|'!='|'<'|'<='|'>'|'>='|'in'|'contains') primary)?
 *   primary := number | string | true | false | path | has '(' path ')' | len '(' expr ')' | '(' expr ')'
 *
 * `x in list` is true when the list holds x: `'admin' in principal.roles`. `text contains 'word'` is true when the
 * text holds the word exactly as written: `email contains '@'`; the word is always a string literal.
 */

export type Comparison = '==' | '!=' | '<' | '<=' | '>' | '>=';
export type BinaryOp = '&&' | '||' | 'in' | 'contains' | Comparison;

export type Expr =
  | { kind: 'lit'; value: string | number | boolean }
  | { kind: 'path'; path: string[] }
  | { kind: 'has'; path: string[] }
  | { kind: 'len'; arg: Expr }
  | { kind: 'not'; arg: Expr }
  | { kind: 'bin'; op: BinaryOp; left: Expr; right: Expr };

export const COMPARISONS: readonly Comparison[] = ['==', '!=', '<=', '>=', '<', '>'];
export const ORDERINGS: readonly Comparison[] = ['<', '<=', '>', '>='];

/** What an expression that cannot be lexed, parsed or typed throws; a rule turns it into a refusal. */
export class ExprError extends Error {}
