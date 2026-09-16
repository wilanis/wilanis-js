/**
 * The vocabulary every document is written in, under the envelope each one carries: the types a shape or a
 * contract names, the fields they are built from, and the values written where an operation is called. It is
 * the grammar the kinds share, so it says nothing about any one kind; which documents exist is `model.ts`.
 */

/** Every document: its kind, what it is for, and optionally a short human name a reader sees instead of its path. */
export interface Envelope {
  $schema: string;
  description: string;
  label?: string;
}

export type TypeRef = string;
export interface InlineObject {
  fields: Record<string, Field>;
  open?: boolean | TypeRef;
  description?: string;
}
export type TypeSpec = TypeRef | InlineObject;
/**
 * One field of a shape or a contract. `static`: where the operation is called the value must be a literal,
 * never a read; a field of type `type` always is. `resolves`: variable -> the path within the document this
 * field's literal names whose value is the type to bind it to (`resolves.ts` holds the grammar).
 */
export interface Field {
  type: TypeSpec;
  required?: boolean;
  description?: string;
  secret?: boolean;
  enum?: string[];
  binds?: string;
  static?: boolean;
  resolves?: Record<string, string>;
}
export type Fields = Record<string, Field>;

/**
 * A value where an operation is called: a literal as written, or a string carrying {{root.path}} templates.
 * Alone, a template takes that value and its type; embedded in text it is interpolated. Lists and objects
 * hold values. This is the one grammar for a node's in, a resolver's in, a delegation's in and a trigger's input.
 */
export type Value = unknown;
export type Values = Record<string, Value>;
