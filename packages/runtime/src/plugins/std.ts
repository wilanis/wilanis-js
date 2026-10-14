/**
 * @std: the pure native operations every graph may use in any layer: objects, text, lists, numbers, outcomes. No effects, no connections.
 * Result types are declared, never inferred: an operation whose result depends on its use takes a `type` field, a literal where it is called.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import { conforms, prune, type Type } from '@wilanis/core';
import { Refusal, readPath } from '@wilanis/engine';
import { ARITHMETIC, ROUNDING } from '../arithmetic.js';

const obj = (value: unknown, what: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${what}: expected an object`);
  return value as Record<string, unknown>;
};
const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new Error(`${what}: expected a string`);
  return value;
};
const arr = (value: unknown, what: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${what}: expected a list`);
  return value;
};
const num = (value: unknown, what: string): number => {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
};
/** A number operation's answer, or a fault where it is not finite; the message never names an operand, which may be secret. */
const finite = (op: string, value: number): number => {
  if (!Number.isFinite(value)) throw new Error(`${op}: the result is not a finite number`);
  return value;
};
/** One of the operations of `@std/number` that take two numbers, over `a` and `b`. */
const twoNumbers = (op: keyof typeof ARITHMETIC, input: Record<string, unknown>): number =>
  finite(op, ARITHMETIC[op](num(input.a, 'a'), num(input.b, 'b')));
/** `round`'s `digits`: a whole number from 0 to 15, 0 when absent. */
const digitsOf = (value: unknown): number => {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 15)
    throw new Error('round: digits must be a whole number from 0 to 15');
  return value as number;
};

/** Judge a result against the declared type when the embedder can resolve it. */
const declared = (value: unknown, type: unknown, env: Record<string, unknown>): unknown => {
  const resolve = env.resolveType as ((ref: string) => Type) | undefined;
  if (resolve && typeof type === 'string') {
    const bad = conforms(value, resolve(type));
    if (bad) throw new Error(`result is not ${type}: ${bad}`);
  }
  return value;
};

/** make's narrowing: the value with what each closed object of the declared type does not declare dropped. */
const trimmed = (value: unknown, type: unknown, env: Record<string, unknown>): unknown => {
  const resolve = env.resolveType as ((ref: string) => Type) | undefined;
  return resolve && typeof type === 'string' ? prune(value, resolve(type)) : value;
};

export const std: PluginModule = {
  root: '@std',
  docs: fileURLToPath(new URL('../../docs/std', import.meta.url)),
  handlers: {
    '@std/object.port.json#make': async ({ in: input, ctx }) =>
      declared(input.trim === true ? trimmed(input.value, input.type, ctx.env) : input.value, input.type, ctx.env),
    '@std/object.port.json#merge': async ({ in: input, ctx }) =>
      declared({ ...obj(input.base, 'base'), ...obj(input.over, 'over') }, input.type, ctx.env),
    '@std/outcome.port.json#refuse': async ({ in: input }) => {
      throw new Refusal(str(input.reason, 'reason'), str(input.message, 'message'));
    },
    '@std/text.port.json#fill': async ({ in: input }) =>
      str(input.template, 'template').replace(/\{([A-Za-z0-9_.]+)\}/g, (_, name: string) => {
        const value = readPath(input.values, name.split('.'));
        return value === undefined ? '' : String(value);
      }),
    '@std/text.port.json#split': async ({ in: input }) =>
      str(input.text, 'text').split(str(input.separator, 'separator')),
    '@std/text.port.json#join': async ({ in: input }) =>
      arr(input.parts, 'parts').map(String).join(str(input.separator, 'separator')),
    '@std/text.port.json#replace': async ({ in: input }) =>
      str(input.text, 'text').split(str(input.find, 'find')).join(str(input.with, 'with')),
    '@std/list.port.json#concat': async ({ in: input, ctx }) =>
      declared([...arr(input.a, 'a'), ...arr(input.b, 'b')], input.type, ctx.env),
    '@std/list.port.json#first': async ({ in: input, ctx }) => {
      const list = arr(input.list, 'list');
      if (!list.length) throw new Error('first: the list is empty');
      return declared(list[0], input.type, ctx.env);
    },
    '@std/list.port.json#count': async ({ in: input }) => arr(input.list, 'list').length,
    '@std/number.port.json#add': async ({ in: input }) => twoNumbers('add', input),
    '@std/number.port.json#subtract': async ({ in: input }) => twoNumbers('subtract', input),
    '@std/number.port.json#multiply': async ({ in: input }) => twoNumbers('multiply', input),
    '@std/number.port.json#divide': async ({ in: input }) => twoNumbers('divide', input),
    '@std/number.port.json#floor': async ({ in: input }) => finite('floor', ROUNDING.floor(num(input.a, 'a'))),
    '@std/number.port.json#round': async ({ in: input }) =>
      finite('round', ROUNDING.round(num(input.a, 'a'), digitsOf(input.digits))),
    '@std/list.port.json#slice': async ({ in: input, ctx }) =>
      declared(
        arr(input.list, 'list').slice(Number(input.from), input.to === undefined ? undefined : Number(input.to)),
        input.type,
        ctx.env,
      ),
  },
};
