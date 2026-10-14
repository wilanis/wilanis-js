/**
 * The handlers of `@std/number.port.json` (RFC 0046), called directly: what each answers, and that a result that is
 * not a finite number is a fault naming the operation and never an operand.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/index.js';

/** Call one operation of `@std/number` with the inputs given. */
function number(op: string, input: Record<string, unknown>): Promise<unknown> {
  const handler = BUILTIN_PLUGINS['@std'].handlers?.[`@std/number.port.json#${op}`];
  if (!handler) throw new Error(`no handler for ${op}`);
  return handler({ in: input, ctx: {} as never });
}

describe('@std/number', () => {
  it('adds, subtracts, multiplies and divides whole numbers, fractions and negative numbers', async () => {
    expect(await number('add', { a: 2, b: 3 })).toBe(5);
    expect(await number('add', { a: 0.1, b: 0.2 })).toBe(0.30000000000000004);
    expect(await number('subtract', { a: 2, b: 5 })).toBe(-3);
    expect(await number('multiply', { a: -4, b: 2.5 })).toBe(-10);
    expect(await number('divide', { a: 7, b: 2 })).toBe(3.5);
    expect(await number('divide', { a: -9, b: 3 })).toBe(-3);
  });

  it('answers a finite result past 2^53', async () => {
    expect(await number('add', { a: Number.MAX_SAFE_INTEGER, b: 2 })).toBe(Number.MAX_SAFE_INTEGER + 2);
  });

  it('breaks where the result is not a finite number, and names no operand', async () => {
    for (const [op, left, right] of [
      ['divide', 1, 0],
      ['divide', 0, 0],
      ['multiply', 1e308, 10],
    ] as const) {
      const fault = number(op, { a: left, b: right });
      await expect(fault).rejects.toThrow(`${op}: the result is not a finite number`);
      await expect(fault).rejects.not.toThrow(String(left));
    }
  });

  it('refuses an operand that is not a number', async () => {
    await expect(number('add', { a: '1', b: 2 })).rejects.toThrow('a: expected a number');
    await expect(number('floor', { a: null })).rejects.toThrow('a: expected a number');
  });

  it('floors toward minus infinity', async () => {
    expect(await number('floor', { a: -2.5 })).toBe(-3);
    expect(await number('floor', { a: 3.5 })).toBe(3);
  });

  it('rounds half away from zero, to the digits given', async () => {
    expect(await number('round', { a: 2.5 })).toBe(3);
    expect(await number('round', { a: -2.5 })).toBe(-3);
    expect(await number('round', { a: -7.25, digits: 1 })).toBe(-7.3);
    expect(await number('round', { a: 1.005, digits: 2 })).toBe(1);
    expect(await number('round', { a: 0.49999999999999994 })).toBe(0);
    expect(Object.is(await number('round', { a: -0.2 }), 0)).toBe(true);
  });

  it('breaks on digits that are not a whole number from 0 to 15, and on an overflow', async () => {
    for (const digits of [16, 1.5, -1])
      await expect(number('round', { a: 1, digits })).rejects.toThrow(
        'round: digits must be a whole number from 0 to 15',
      );
    await expect(number('round', { a: 1e308, digits: 15 })).rejects.toThrow('round: the result is not a finite number');
  });
});
