/**
 * The operations of `@std/number`, by name: what its handlers answer, held once so that whatever else computes them
 * answers the same (RFC 0046). Each answers a double, finite or not; the handler decides what a result that is not
 * finite means.
 */

/** The operations that take two numbers, the port's `a` (left) and `b` (right). */
export const ARITHMETIC = {
  add: (left: number, right: number) => left + right,
  subtract: (left: number, right: number) => left - right,
  multiply: (left: number, right: number) => left * right,
  divide: (left: number, right: number) => left / right,
} as const;

/**
 * The operations that take one number. `round` rounds half away from zero: `Math.round` rounds a half up, which on
 * `|value| × 10^digits`, never negative, is away from zero; `-0` is answered as 0.
 */
export const ROUNDING = {
  floor: (value: number) => Math.floor(value),
  round: (value: number, digits = 0) =>
    (Math.sign(value) * Math.round(Math.abs(value) * 10 ** digits)) / 10 ** digits + 0,
} as const;
