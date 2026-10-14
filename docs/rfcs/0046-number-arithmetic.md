# RFC 0046: Arithmetic on numbers: `@std/number` adds, subtracts, multiplies, divides and rounds

- **Status:** draft
- **Areas:** `area:runtime` (the `@std` plugin: a new `docs/std/number.port.json`, `docs/std/plugin.json`,
  `src/plugins/std.ts`, a new `src/arithmetic.ts`; the rehearsal: `rehearse-where.ts`, `rehearse-reached.ts`,
  `rehearse.ts`, `branches.ts`, `demands.ts`, a new `demand-arithmetic.ts`, `demand-said.ts`; the template's
  `CLAUDE.md`), and `docs/model.md`. Nothing in core, the engine, the compiler, the viewer or another plugin. No
  schema changes.
- **Tracking issue:** #1034
- **Depends on:** RFC 0018 (implemented: the branch solver), RFC 0038 (implemented: `traced` in `frames.ts`), and
  issue #1027 (closed: the rehearsal stubs only effects and carries a demand through a `make`, a `merge`, `first`, a
  keep and a call into the tree's graphs, `inward` and `intoCall`). The rehearsal step below is written on what those
  leave at commit 1feb33d.

## Summary

A graph can compute a number. `@std/number.port.json` is a fifth port of the standard library, granted by `@std`,
with six pure operations. `add`, `subtract`, `multiply` and `divide` take two numbers, `a` and `b`; `floor` and
`round` take one, `a`, and `round` a static count of `digits`. Each answers a number. The arithmetic is JavaScript's
`+`, `-`, `*` and `/` over IEEE 754 doubles, and `round` rounds half away from zero by a rule the port states. A result that is not a
finite number (a division by zero, an overflow to `Infinity`, `NaN`) is a fault of the node, as `@std/list#first`
faults on an empty list. No checker rule refuses it. An author guards a division with a switch on `b != 0` that
routes to the `divide` node. The rehearsal follows a demand on an arithmetic answer back to an operand: it holds the
other operand at a literal or at the value it has on the run, and inverts the operation. So a switch such as
`ratio > 60` over `multiply(bold, 100)` has both branches steered from the data that feeds the multiply, and never
from a stub on the multiply node. The rule grammar does not change: a rule still compares, and arithmetic happens in
nodes.

## Motivation

A graph cannot multiply or divide today. `@std` grants four ports (`packages/runtime/docs/std/plugin.json`), and no
operation of any of them takes two numbers. A graph adds only by counting: `@std/list.port.json#count` of a
`#concat` answers the sum of two lengths. RFC 0039's `#totals` sums a number field per key, but it does not multiply,
and at 1feb33d it is accepted and not yet in `list.port.json`.

A consumer tree that checks writing met this. Its rules are products and ratios of counts:

- a text takes too long to read when `W × 60 > core_read_seconds × words_per_minute`;
- too much of it is bold when `B × 100 > bold_max_percent × W`;
- two sets of words overlap too much when `100 × |A ∩ B| > max × |A ∪ B|`;
- an indent level is the count of leading spaces divided by 2, rounded down;
- a readability grade is computed in doubles and shown rounded half away from zero to one decimal.

Each of `W`, `B`, `|A ∩ B|` is a `#count`. Nothing in the tree can multiply one by 60 or by 100. So the tree has two
ways, as RFC 0040's consumer had:

1. **A plugin computes the number, and the graph reads it.** The plugin is a package with a handler, a port document
   and tests. The arithmetic sits in code the checker cannot see. Unless the operation says `pure`, the rehearsal
   stubs its answer as an effect, so a switch over it is steered by a number no count produced.
2. **The caller computes every product and hands it in.** Then the tree no longer states the rule it checks.

Now that a graph may call itself (issue #1032, fixed in #1033, after 1feb33d), a graph that counts down needs
`subtract` too.

**What this does not try to solve.** Showing a number with a fixed count of decimals: `#fill` writes `String(value)` (`packages/runtime/src/plugins/std.ts`), so a grade of `7` shows as
`7`, not `7.0`. Arithmetic inside a rule. A sum or a mean over a whole list. Set intersection and union. Integers
beyond 2^53.

## Guide-level explanation

**A number operation** takes `a` and `b` and answers one number:

| Operation | Answers |
|---|---|
| `@std/number.port.json#add` | `a + b` |
| `@std/number.port.json#subtract` | `a - b` |
| `@std/number.port.json#multiply` | `a × b` |
| `@std/number.port.json#divide` | `a / b` |
| `@std/number.port.json#floor` | the largest whole number not above `a` |
| `@std/number.port.json#round` | `a` rounded to `digits` decimals, half away from zero |

Every input is a required number, except `round`'s `digits`. A literal is written as it is (`"b": 100`), a constant as a read of it
(`"b": "{{const.limit}}"`), and another node's answer as a read (`"a": "{{activeCount}}"`). A read of an optional
number needs a `has()` first, as every read does (G004).

The numbers are doubles, as in JavaScript. Whole numbers are exact up to 2^53 (`Number.MAX_SAFE_INTEGER`). A fraction
may not be exact: `0.1 + 0.2` answers `0.30000000000000004`. A result that is not a finite number breaks the node.
The run fails there as a fault, with the message `divide: the result is not a finite number`. The message names the
operation and never the operands, since an operand may be a value marked secret.

### Dividing safely

Say the example's digest should also say whether most customers are active: more than 60 in 100.
`example/features/customers/domain/digest.graph.json` already counts them (`count`, `activeCount`). It would gain:

```json
{
  "type": "@wilanis/node/run.schema.json",
  "id": "activeHundreds",
  "label": "Active customers, times 100",
  "run": "@std/number.port.json#multiply",
  "in": { "a": "{{activeCount}}", "b": 100 }
},
{
  "type": "@wilanis/node/switch.schema.json",
  "id": "anyCustomer",
  "label": "Is there a customer to divide by?",
  "in": { "count": "{{count}}" },
  "rules": [{ "when": "count != 0", "to": "activePercent" }],
  "else": "noCustomer"
},
{
  "type": "@wilanis/node/run.schema.json",
  "id": "activePercent",
  "label": "Active customers, in percent",
  "run": "@std/number.port.json#divide",
  "in": { "a": "{{activeHundreds}}", "b": "{{count}}" }
},
{
  "type": "@wilanis/node/switch.schema.json",
  "id": "mostlyActive",
  "label": "Are most customers active?",
  "in": { "percent": "{{activePercent}}" },
  "rules": [{ "when": "percent > 60", "to": "busy" }],
  "else": "quiet"
}
```

`noCustomer`, `busy` and `quiet` each make the digest, and `out.from` names the three. `anyCustomer` routes to
`activePercent` only where `count != 0`. The kernel cancels a node on a branch its switch did not take, so no run
divides by zero.

Without `anyCustomer`, a tree with no customers breaks at `activePercent`. The checker does not refuse that: whether
`count` is 0 is a fact of the run, not of the documents. A run that divides by zero is reported as any fault is:
`BROKE` in `wilanis rehearse`, a fault in `fuzz` and `regress`. A `catch` cannot route it, since G024 refuses a catch
of a pure operation: "nothing here breaks but a bug, which rehearse reports as BROKE; delete catch".

### Comparing two computed numbers

A rule compares a value with a literal: `percent > 60`. A rule that orders two values read from the inputs, such as
`activeHundreds > countSixties`, types, but the rehearsal cannot steer it. `paired` in
`packages/runtime/src/solve-pairs.ts` relates two values only by `==` and `!=`, and an ordering only where one side is
a length. So such a rule reads `NEVER RUN -- the solver cannot compare two paths as '...' does` (`whyUnsolved` in
`solve.ts`). A limit kept in `const` and read through the switch's `in` is a read too, so `percent > limit` meets the
same limit.

So subtract one from the other, and compare the difference with 0. This is the form of the consumer's
`B × 100 > bold_max_percent × W`. It needs no guard, since nothing divides:

```json
{ "type": "@wilanis/node/run.schema.json", "id": "countSixties", "label": "The count, times 60",
  "run": "@std/number.port.json#multiply", "in": { "a": "{{count}}", "b": 60 } },
{ "type": "@wilanis/node/run.schema.json", "id": "margin", "label": "How far past 60 in 100",
  "run": "@std/number.port.json#subtract", "in": { "a": "{{activeHundreds}}", "b": "{{countSixties}}" } },
{ "type": "@wilanis/node/switch.schema.json", "id": "mostlyActive", "label": "Are most customers active?",
  "in": { "margin": "{{margin}}" }, "rules": [{ "when": "margin > 0", "to": "busy" }], "else": "quiet" }
```

### Rounding

`floor(-2.5)` is `-3`: rounded down means toward minus infinity. `round` rounds half away from zero. With
`m = 10^digits`, it answers `sign(a) × r / m`, where `r` is the whole number nearest to `|a| × m`, computed in
doubles, the larger one where two are equally near. So `round(2.5)` is `3`, `round(-2.5)` is `-3`, and
`round(-7.25, 1)` is `-7.3`. The rule is the definition, so a value that is not exact in binary rounds as the rule
computes it: `round(1.005, 2)` is `1`, since `1.005 × 100` is `100.49999999999999`. A result of `-0` is answered as
`0`. `digits` is static, a whole number from 0 to 15, and 0 when absent; any other value breaks the node on every run.

The consumer's indent level is `floor(divide(spaces, 2))`, and its grade is shown as `round(grade, 1)`. Showing `8.0`
with its trailing zero is a text concern (`#fill` writes `String(value)`), not this RFC's.

### What the rehearsal does

`wilanis rehearse` stubs effects alone and runs the arithmetic. For `percent > 60`, it asks `activePercent` for a
number above 60, and follows that demand back. `activePercent` divides by `count`, so the rehearsal holds `count` at
the value it has on this run, call it `n`. `n` is not 0, because the rehearsal steered `anyCustomer` to
`count != 0` first. It asks `activeHundreds` for more than `60 × n`. `activeHundreds` multiplies by the literal 100,
so it asks `activeCount` for more than `60 × n ÷ 100`, rounded to a whole number. That demand lands where any demand
on `activeCount` lands. The report reads as today:

```
features/customers/domain/digest  switch 'mostlyActive'  2/2 branches
  ok  when percent > 60  answered from 'busy'
  ok  anything else      answered from 'quiet'
```

(`activeCount` is itself a `#count`. At 1feb33d the rehearsal does not follow a `#count` back to its list, so the
demand stops there as a stub of the count, as it does for any switch over a count today. #1036 tracks that.)

Where the rehearsal cannot follow a demand back, the branch reads `NEVER RUN` and names the node:

```
  ??  when share > 5  NEVER RUN -- share is divided by what 'share' in features/customers/domain/digest is handed as b, and the rehearsal does not solve for a divisor: write the rule over the divisor itself
```

## Reference

### Documents and schemas

None. No new kind, no new field, and no change under `packages/core/schemas/`, so the implementing pull requests do
not wait on the `decision` job.

### Ports, operations and kinds granted

**`packages/runtime/docs/std/number.port.json`** (new):

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/port.schema.json",
  "label": "Numbers",
  "description": "Numbers: add, subtract, multiply, divide, floor, round. IEEE 754 doubles, as JavaScript computes them; whole numbers are exact up to 2^53. A result that is not a finite number breaks the node.",
  "operations": {
    "add": {
      "description": "a + b.",
      "accepts": { "a": { "type": "number" }, "b": { "type": "number" } },
      "returns": "number",
      "pure": true
    },
    "subtract": {
      "description": "a - b. To compare two computed numbers, subtract one from the other and compare the difference with 0.",
      "accepts": { "a": { "type": "number" }, "b": { "type": "number" } },
      "returns": "number",
      "pure": true
    },
    "multiply": {
      "description": "a × b; fails where the result overflows to Infinity.",
      "accepts": { "a": { "type": "number" }, "b": { "type": "number" } },
      "returns": "number",
      "pure": true
    },
    "divide": {
      "description": "a / b; fails where b is 0 (guard with a switch on b != 0 that routes here) or the result overflows.",
      "accepts": { "a": { "type": "number" }, "b": { "type": "number" } },
      "returns": "number",
      "pure": true
    },
    "floor": {
      "description": "The largest whole number not above a: floor(-2.5) is -3.",
      "accepts": { "a": { "type": "number" } },
      "returns": "number",
      "pure": true
    },
    "round": {
      "description": "a rounded to digits decimals, half away from zero: sign(a) × r / 10^digits, where r is the whole number nearest to |a| × 10^digits in doubles, the larger where two are equally near. -0 is answered as 0.",
      "accepts": {
        "a": { "type": "number" },
        "digits": { "type": "number", "required": false, "static": true, "description": "a whole number from 0 to 15; 0 when absent" }
      },
      "returns": "number",
      "pure": true
    }
  }
}
```

`subtract` is in the port because without it `a - b` takes a `multiply` by `-1` and an `add`, and because the
difference against 0 is how a rule compares two computed numbers (*Comparing two computed numbers*, above).

`digits` is `static`, a literal where the node is written, because a precision is a decision of the graph, not a
value of the run, and the rehearsal then never has to solve for it.

**`packages/runtime/docs/std/plugin.json`** lists `@std/number.port.json` under `grants.ports`. Its description
becomes "Pure operations on objects, text, lists, numbers and outcomes. Safe in any layer."

**The handlers.** A new module `packages/runtime/src/arithmetic.ts` holds the six operations once, in two tables:

```ts
/** The operations of `@std/number`, by name: what the handlers answer, and what the rehearsal inverts and computes. */
export const ARITHMETIC = {
  add: (a: number, b: number) => a + b,
  subtract: (a: number, b: number) => a - b,
  multiply: (a: number, b: number) => a * b,
  divide: (a: number, b: number) => a / b,
} as const;

/** The operations of `@std/number` that take one number: `round` half away from zero, `-0` answered as 0. */
export const ROUNDING = {
  floor: (a: number) => Math.floor(a),
  round: (a: number, digits = 0) => (Math.sign(a) * Math.round(Math.abs(a) * 10 ** digits)) / 10 ** digits + 0,
} as const;
```

`Math.round` rounds a half up, toward plus infinity, which on `|a| × m`, never negative, is away from zero.

`std.ts` gains one handler per operation, `@std/number.port.json#<name>`. Each reads its operands through a `num`
helper beside `str` and `arr` (it throws `a: expected a number` for anything else), answers `ARITHMETIC[name](a, b)`
or `ROUNDING[name](a, digits)`, and throws `<name>: the result is not a finite number` where `Number.isFinite` is
false of the result. `round` first throws `round: digits must be a whole number from 0 to 15` for any other
`digits`. The test is on
the result alone: an operand is never `Infinity` or `NaN`, since JSON has neither and an operation that made one
faulted. The rehearsal reads the same tables (below), so the solver and the handler cannot disagree on what an
operation answers. The module comment of `std.ts` gains "numbers".

No other port, kind, codec or shape.

### Checker rules

No new code. The table names the existing codes that meet the new operations.

| Code | Where it lives | What it does with them |
|---|---|---|
| G004 | `check/inputs.ts` | an optional number read into `a` or `b` is refused, as into any required input |
| G011 | `check/graph-nodes.ts` (`checkRule`) | a rule over an arithmetic answer types it as `number`, from the operation's `returns` |
| G017 | `check/attempts.ts` | a `retry` on an arithmetic node is refused: it is pure |
| G024 | `check/graph-nodes.ts` (`whyNeverBreaks`) | a `catch` of an arithmetic node is refused: it is pure, so it breaks only by a bug, which a division by zero is |

A domain graph may run them, since the only native operations a domain graph runs are pure ones.

**`prove.ts`.** No code change. A number an operation answers is never established at a site by any of the three
rules of `packages/compiler/src/check/prove.ts`:

- *literal*: `literalFields` needs every root the conjunct reads to be a literal at the site (`scope.literal`). A
  field written `"{{activePercent}}"` is a template, so `literalTrue` never evaluates it. The checker runs no
  operation, so `multiply(2, 3)` is not folded to 6 either, and I005 never sees a computed number.
- *narrowed*: `implies` compares spellings, and `stronger` does no arithmetic ("Deliberately no arithmetic on the
  literals"). A switch that tested `percent > 60` proves `percent > 60` only where the site reads its value whole
  (`site.from`), as for any read today.
- *through*: unchanged; it never reads the rule.

So a site that writes a computed number into a field a `holds` rule reads is guarded, and the guard judges the number
the run computed. That is the safe direction: "Being wrong here silently removes a guard."

### Runtime behaviour

**The kernel.** No change. An arithmetic node is a `call` of a pure operation. Its answer is `«secret»` whole where
it read an operand as `«secret»`, by the rule `docs/security-model.md` states for a pure node whose answer holds
nothing it read so.

**The rehearsal today.** A demand on a node's answer is met in `meet` (a read of a sibling node) and in `ofTraced`
(a read traced out of `in`), both in `packages/runtime/src/demands.ts`. Each tries, in order: a map's rule
(`mapRuleOf`), what the node is run from (`inward`: a `make`'s value, a `merge`'s `over`, `first`'s element 0, the
`over` of a map with no rule, all read off `writtenAt` in `rehearse-where.ts`), and a call into one of the tree's
graphs (`called`, which runs `intoCall` in `demand-calls.ts`). A node that is none of these gets a stub of its own
answer: the last line of `meet`, and `onNode` in `ofTraced`.

So, at 1feb33d, a switch over the answer of a pure operation that `inward` does not know is steered by a stub at that
pure node. Take a tree that reads a list through the test plugin `@source`, counts it with
`@std/list#count` and switches on `n > 2`: both branches settle, and the runs are handed `{ "op.n": 3 }` and
`{ "op.n": 0 }`. Each such run computes nothing from its data: the count disagrees with the list it counts. Issue
#1027 decided against this ("Where no demand can be carried back, the case is reported, never run on a stub the rule
forbids"), and the template says such an operation stops the trace with `NEVER RUN`. The code does not do that yet
for `count`, `slice`, `concat`, `fill`, `join`, `split` and `replace`. Without this RFC's rehearsal step, the six new
operations would meet the same fallback: `ratio > 60` over `multiply(bold, 100)` would settle on a stub at the
multiply node. #1036 tracks the bug for the other pure operations. This RFC does not depend on it, because it handles
every arithmetic node itself and never falls through to that stub.

**What changes.**

1. `rehearse-where.ts` gains `arithmeticAt(emb, root, nodePath)`, beside `writtenAt`: for a node that is a `call` (not
   a map) whose handler is one of the six operations, `{ op, a, b }` or `{ op, a, digits }`, with `a` and `b` its
   lowered sources and `digits` the literal. Nothing for any other node.
2. `Stubbing` in `branches.ts` gains `arithmeticOf?: (nodePath) => Arithmetic | undefined` and
   `probed?: (nodePath) => unknown`, what the node answered in the first run. `switchesReached` in
   `rehearse-reached.ts` sets both. For `probed`, it keeps the report of `probe.fire`, which it discards today, and
   reads it with `reportAt`, which moves from `rehearse.ts` to `rehearse-reached.ts` (`rehearse.ts` already imports
   that module). `edges-held.ts` spreads `walk.stubbing`, so `fuzz --edges` inherits both.
3. A new module `packages/runtime/src/demand-arithmetic.ts` exports `throughArithmetic`. `meet` and `ofTraced` call it
   right after `inward` and before `called`. It answers for every node `arithmeticOf` names, so no demand on such a
   node falls through to a stub of it. Like `intoCall`, it takes what it calls back as an object (`landing`, to meet
   an operand's demand as `ofTraced` meets a landing; `overrides`; `generated`, `inputSeed`, `probed`), so
   `demands.ts` and the new module do not import each other. `onNode` and `stubTarget` are exported from `demands.ts`
   for it.

**`throughArithmetic`, step by step.** Its input is the node, the demand `D` on its whole answer (a `Domain`), where
the node stands, and `each` where the demand stands for every element.

1. *Classify each operand.* Each source is followed with `writtenThrough(source, [], { ...standing, at: node })` in
   `frames.ts`, as `inward` follows a `make`'s value. It either lands (`Landed`: a node, or the trigger's input), so it
   is **steerable**; or it stops at a literal, so it is **fixed** at that value (a constant is a literal by then: the
   compiler writes `{ value }` where `const` is read, `lower.ts`); or it stops otherwise (`context`, text composed
   from reads, a list written out), so it is **unknown**.
2. *Choose the operand to steer, and the value `c` of the other.*

   | Operands | What happens |
   |---|---|
   | both fixed | The answer is `y = ARITHMETIC[op](a, b)` on every run. Not finite: the node breaks on every run that reaches it (unreachable, sentence *breaks*). Else, where `meets(y, D)` (`domains.ts`), the demand is met with nothing written (`Fixed`); where not, the branch is closed on this path (sentence *fixed*). |
   | one steerable, one fixed at `c` | Steer the steerable one, with `c`. |
   | both steerable | Two ways: steer `a` with `b` held at its value, or steer `b` with `a` held at its value. `divide` has the first way only. |
   | either unknown | Unreachable, with the sentence `stoppedSaid` already writes for that operand's stop (`demand-said.ts`), as `ofStopped` writes it. |

   **The held value** of a steerable operand is the value it has under what the case is laid over:
   - landed on the trigger's input: `getPath(inputSeed, path)`;
   - landed on another arithmetic node: that node's operands' held values, through `ARITHMETIC`;
   - landed on any other node: the value the stubbing holds at its stub target (`generated`, which `over` makes
     answer what earlier decisions steered), else what the node answered in the first run (`probed`).

   A held value that is not a finite number (missing, a node the first run never reached, a value shown as
   `«secret»` in the report) is unknown, and that way is not taken. Of the ways left, `throughArithmetic` takes the
   one `chosen` in `demand-calls.ts` would take: the first whose met demand misses nothing and that `overrides` says
   changes nothing another decision steered; else the first that misses nothing; else it answers the first way's
   reason. Where no way has a held value, the sentence is *neither known*.
3. *Invert.* With `x` the operand steered and `c` the other, the answer is a line in `x`, `y = s·x + t`, and the
   demand on `x` is `D` mapped through `x = (y − t) / s`:

   | Operation, `x` is | `s`, `t` | The demand on `x` |
   |---|---|---|
   | `add`, either | `1`, `c` | every bound, `eq` and `ne` of `D` minus `c` |
   | `subtract`, `a` | `1`, `−c` | every bound, `eq` and `ne` plus `c` |
   | `subtract`, `b` | `−1`, `c` | `c` minus each; `>` becomes `<`, `>=` becomes `<=`, and back |
   | `multiply`, either, `c > 0` | `c`, `0` | each divided by `c` |
   | `multiply`, either, `c < 0` | `c`, `0` | each divided by `c`, the bounds flipped as for `subtract`'s `b` |
   | `multiply`, either, `c = 0` | | the answer is 0 on every such run: met (`Fixed`) where `meets(0, D)`, else closed (sentence *fixed*) |
   | `divide`, `a`, `c ≠ 0` | `1/c`, `0` | each times `c`, flipped where `c < 0` |
   | `divide`, `a`, `c = 0` | | the node breaks on every such run: unreachable (sentence *breaks*) |
   | `divide`, `b` | | not solved: unreachable (sentence *divisor*) |
   | `floor`, `a` | | the demand passes to `a` as it is: on a whole number `floor(x)` is `x`, and the solver's domains hold whole numbers (step 4) |
   | `round`, `a` | | the same, for every `digits`: a whole number rounds to itself |

   `floor` and `round` have one operand, so step 2 has nothing to choose: `a` is steered where it lands, fixed where it
   is a literal (the answer is then computed once, as for two fixed operands), and unknown otherwise.

   `present` passes to `x` as it is. `absent` cannot be met, since the node answers whenever it runs: closed
   (sentence *answers*). `paired` (the switch compares the answer with another read, `==` or `!=`) cannot be inverted,
   since its partner is not fixed: unreachable (sentence *paired*). The solver does not make any other demand of a
   value the checker typed `number`.
4. *Whole numbers.* `domains.ts` assumes whole numbers ("Integers are assumed; the grammar's literals are exact",
   `emptyRange`), and `withinRange` in `stubs.ts` steps a bound by 1. So an inverted bound `v` that is not whole is
   rounded to the bound that admits the same whole numbers: `gt v` becomes `gt ⌊v⌋`, `gte v` becomes `gte ⌈v⌉`,
   `lt v` becomes `lt ⌈v⌉`, `lte v` becomes `lte ⌊v⌋`. An inverted `eq v` that is not whole cannot be met by a whole
   number: unreachable (sentence *whole*). An inverted `ne v` that is not whole excludes no whole number and is
   dropped. So `multiply(x, 100) > 60` asks `x` for `gt 0`, and `x × 3 == 10` asks for nothing it can meet.
5. *Meet the operand's demand.* The inverted demand is met where the operand landed, through `landing`, which is
   `ofTraced` with the new domain. So a chain recurses one node at a time: `margin` is a `subtract` of two
   `multiply` nodes, each of which inverts again. The landing may be an effect's stub, a patch to the trigger's input,
   a call into one of the tree's graphs, a `make`, or another arithmetic node, as for any demand. Where the
   arithmetic node's landing carried `each`, each operand's landing carries it too (`withEvery`). Where both operands
   are steerable, the case writes two things: the steered operand's demand, and nothing for the held one, since its
   value is the one the run already gives it.

**The sentences.** `demand-said.ts` gains `computedSaid`. `<at>` is the node as `nodeSaid` writes it (`'margin' in
features/customers/domain/digest`), and `<field>` the switch's input the demand is on, as `exhaustedOf` names it.

| Sentence | Missed as | Words after `NEVER RUN --` or `closed on this path:` |
|---|---|---|
| *divisor* | unreachable | `<field> is divided by what <at> is handed as b, and the rehearsal does not solve for a divisor: write the rule over the divisor itself` |
| *whole* | unreachable | `<field> must be <e>, and no whole number handed to <at> answers it: compare with <, <=, > or >= instead` |
| *paired* | unreachable | `<field> is computed at <at> and compared with another value, which the rehearsal cannot solve: subtract one from the other and compare the difference with 0` |
| *neither known* | unreachable | `the rehearsal knows neither operand of <at> before the run, so it cannot solve for one: hand one of them as a literal, or as a read of an effect` |
| *breaks* | unreachable | `<at> divides by 0 on every run that reaches it` |
| *fixed* | closed | `<at> answers <y> on every run` |
| *answers* | closed | `<at> answers a number on every run that reaches it, so <field> is never missing` |

A case missed as unreachable prints `  ??  when <rule>  NEVER RUN -- <sentence>` (`rehearsal-report.ts`). A case
closed on this path prints `  --  ...  closed on this path: <sentence>`, and `NEVER RUN` where every path closes it,
as today.

**What stays `NEVER RUN`, and what the line says.**

- A rule over `a / b` where only the divisor can be steered: *divisor*.
- An equality no whole number meets after inversion: *whole*.
- An arithmetic answer compared with another read by `==` or `!=`: *paired*. Ordered with another read (`>`), the
  solver itself finds no case first: `the solver cannot compare two paths as '<rule>' does`.
- An operand read from `context`, or composed: the sentence `stoppedSaid` writes for that read.
- Two steerable operands, neither with a value known before the run: *neither known*.
- A `divide` by a fixed 0: *breaks*.
- A `map` that runs an arithmetic operation per element: `arithmeticAt` answers nothing for a map, so a demand on one
  element's answer meets today's fallback for a map element (a stub at `<map>.0`). This RFC does not change that.

**What the run checks.** The solver works in whole numbers, and the run works in doubles. Every case is run, and
`settle` in `rehearse.ts` reads where the switch routed. A case the doubles route elsewhere is reported
`WRONG ROUTE -- should go to '<to>', went to '<other>'`, never as a settled branch. For example, `x × 0.1 == 3`
solves `x = 30`, and `30 * 0.1` answers `3.0000000000000004`.

**The guard pattern, checked against `reach`.** In the digest above, `mostlyActive` reads `activePercent`, which
`anyCustomer` routes to. `routingTo` in `rehearse-reached.ts` finds `anyCustomer` among the switches that route a node
`mostlyActive` waits for, and `reach` steers it to `activePercent` before any case of `mostlyActive` is built. That
writes `count != 0` into what the case is laid over. So `count`'s held value is not 0 when `throughArithmetic` holds
it, and the divide's own case does not undo the routing: it writes nothing for the held divisor. Where a case does
undo it, `reachedOrAgain` in `rehearse.ts` solves the routing again over the case, as it does for any switch. The
`else` of `anyCustomer` is its own case (`count == 0`), and in it `activePercent` and `mostlyActive` are cancelled,
so nothing divides. Nothing in this path needs a change.

**`fuzz`, `fuzz --edges`, `regress`, `start`.** No change. `generate` in `packages/core/src/generate.ts` picks numbers
from a pool that holds 0, so a `fuzz` run of an unguarded `divide` whose divisor comes from a generated value can
break; it is recorded as a fault, which is the true answer for that input. `fuzz --edges` hands a number from the
trigger's input the edges `zero`, `negative`, `fraction` and `max` (`valueEdges`), so an unguarded division by the
caller's number is recorded as a fault there too. `regress` replays what was recorded.

### Discoverability

- `wilanis describe @std/number.port.json` lays the port out, with `granted by  @std  (built into the runtime)`;
  `wilanis describe @std/plugin.json` lists it under what the plugin grants. The viewer's port page shows it. Neither
  needs code.
- `wilanis manifest` lists the new port under `documents` and `ports`, so the two generated goldens move:
  `packages/runtime/test/manifest.golden.json` and `packages/deploy/test/fixtures/customers.manifest.json`.
- `docs/model.md`: the heading *The standard library is four ports* becomes *five ports*, and its line gains
  "`@std/number` (`add`, `subtract`, `multiply`, `divide`, `floor`, `round`)".
- `packages/runtime/templates/CLAUDE.md`:
  - **The standard library** becomes "five ports", and names `@std/number.port.json` (`add`, `subtract`, `multiply`,
    `divide` two numbers `a` and `b`; `floor` and `round` one, `a`, with `round` taking a static `digits` and rounding
    half away from zero; a result that is not a finite number breaks the node, so route a `divide` behind a switch on
    `b != 0`). It gains: "A rule compares a value with a literal; to compare two computed
    numbers, `subtract` one from the other and compare the difference with 0."
  - Loop step 2 lists the six `@std/number` operations among the nodes rehearse runs and follows a value
    back through, and says: "A value an arithmetic operation answers is followed to an operand, the other held at the
    literal or the value it has on the run; a divisor, an equality no whole number meets, and an operand read from
    `context` stop it."
- `packages/runtime/templates/dot-claude/skills/wilanis-graphs/SKILL.md`: no change. It names no list of the `@std`
  operations; `init.test.ts` and `graphs-skill.test.ts` pin only `#merge`, `#make` and `#refuse` there.

### Plugin contract

None.

## What it does not do

- **No arithmetic in a rule.** Rules keep `has`, comparisons, `in`, `contains` and `len`. Three reasons, in the
  spirit of RFC 0040's reasons for keeping regular expressions out:
  1. *The fault.* In a rule, `count / 0` would evaluate to `Infinity`, and `0 / 0` to `NaN`, which compares false with
     everything (`compare` in `packages/core/src/expr/evaluate.ts`). A switch would route to its `else`, and a guard
     would refuse, with no fault and no node to name. As an operation, the same division breaks a named node, and
     every tool says where.
  2. *The value.* The consumer needs the computed number as a value, not only in a comparison: the readability grade
     is shown. So an operation is needed in any case, and arithmetic in rules would be a second way to compute.
  3. *The grammar.* `lex.ts` reads `-` before a digit as the sign of a number (`numberAt`), so `a-1` lexes as `a` and
     `-1`, and `+`, `*` and `/` are not in `OPS`. Each would need a decision in the lexer, a type rule in `check.ts`,
     words in the viewer's `said.ts`, and a place in `prove.ts`'s spelling.

  *Drawbacks and alternatives* says where the grammar would do better.
- **One rounding rule.** `round` rounds half away from zero. Half to even, `ceil` and `trunc` are left out until a
  tree needs them; `ceil(x)` is `subtract(0, floor(subtract(0, x)))` meanwhile.
- **No integer type.** A number is a double; a whole number is exact up to 2^53, and a result past it is still
  finite, so it is not a fault.
- **No refusal of a literal 0 divisor.** `"b": 0` breaks on every run that reaches it, and the rehearsal says so
  (*breaks*). A checker rule could refuse it; it is left out, as decided for every non-finite result.
- **No following of `#count`.** That is a bug against #1027's decision, tracked as #1036.

## Compatibility

IR v1: no schema changes. `@std/number.port.json` is a new port a plugin grants. Every document that validated before
still validates and means the same. A tree written before this RFC names no `@std/number` operation, so nothing it
runs changes. Every tree's manifest gains one port. This is compatible under RFC 0008 before and after 1.0, so it
need not land before the `schemas-v1` freeze.

## Tests

**The `@std` handlers.** The `@std` handlers have no test file of their own at 1feb33d; they are tested only through
trees that call them. This RFC adds `packages/runtime/test/std-number.test.ts`, which calls
`BUILTIN_PLUGINS['@std'].handlers` directly:
- each operation answers for whole numbers, for fractions (`0.1 + 0.2` is `0.30000000000000004`), and for negative
  numbers;
- `divide(1, 0)`, `divide(0, 0)` and `multiply(1e308, 10)` throw `<op>: the result is not a finite number`, and the
  message holds neither operand;
- `add(Number.MAX_SAFE_INTEGER, 2)` answers, since its result is finite;
- a string operand throws `a: expected a number`;
- `floor(-2.5)` is `-3` and `floor(3.5)` is `3`;
- `round(2.5)` is `3`, `round(-2.5)` is `-3`, `round(-7.25, 1)` is `-7.3`, `round(1.005, 2)` is `1`,
  `round(0.49999999999999994)` is `0`, and `round(-0.2)` is `0` and not `-0` (`Object.is`);
- `round(1, 16)`, `round(1, 1.5)` and `round(1, -1)` throw the `digits` message; `round(1e308, 15)` throws
  `round: the result is not a finite number`.

**The rehearsal** (`packages/runtime/test/rehearse-arithmetic.test.ts`, with its trees in
`rehearse-arithmetic-trees.ts`, built with the helpers of `rehearse-stubs-trees.ts` and reading their data through
`@source`, as `rehearse-keep-trees.ts` does):
- for each of `add`, `subtract`, `multiply` and `divide`, a switch `y > k` over its answer, one operand a field of a `@source` read and the
  other a literal: both branches settled, and every stub handed to a run is at the `@source` effect, never at the
  arithmetic node (the check `rehearse-keeps.test.ts` makes by wrapping `Embedder.prototype.fire`). The literal on
  the left and on the right; `subtract` with the read as `b`; `multiply` by a negative literal; `divide` by a literal;
- both operands read through `@source`: both branches settled, the held operand left at the value its stub has;
- the two-products form (`multiply`, `multiply`, `subtract`, `margin > 0`): both branches settled;
- the guarded divide (`b != 0` routing to the `divide`, a switch over its answer): every branch of both switches
  settled, none `BROKE`;
- a switch `level > 1` over `floor(divide(x, 2))`, and one over `round(x, 1)`: both branches settled, the stubs at
  the `@source` effect;
- `NEVER RUN` with each sentence: a literal dividend over a `@source` divisor (*divisor*); `y == 10` over
  `multiply(x, 3)` (*whole*); an operand read from `context`; a `multiply` of two literals whose answer the branch
  excludes (closed, *fixed*);
- the inversion alone, case by case: each row of the table, each rounding of a bound, an `eq` that is not whole, an
  `ne` that is dropped.

**The proof** (`packages/runtime/test/invariant-proof.test.ts`): a site that writes a guarded number field from a
`#multiply` answer is `guarded`. This holds "no change in `prove.ts`".

**The goldens.** `npx vitest run packages/runtime/test/manifest.test.ts -u` and
`npx vitest run packages/deploy/test/fixture.test.ts -u`, and the diff is one more port.

**The example.** No change. The rehearsal tests build their own trees, so `example/scenarios/` does not move.

## Implementation plan

Each step is one pull request and one sub-issue, and each leaves `npm test` passing.

1. **The port and its handlers.** `number.port.json`, the grant in `plugin.json`, `arithmetic.ts`, the six handlers
   in `std.ts`, `std-number.test.ts`, the two regenerated goldens, the line in `docs/model.md`, and the template's
   **The standard library** bullet. No `decision` job. Until step 2, a switch over an arithmetic answer is steered by
   a stub at the arithmetic node, the fallback a switch over a `#count` meets today: it settles, on a value no operand
   produced. A good first issue.
2. **The rehearsal follows arithmetic.** `arithmeticAt` in `rehearse-where.ts`; `arithmeticOf` and `probed` in
   `Stubbing` and `switchesReached`, with `reportAt` moved; `throughArithmetic` in `demand-arithmetic.ts` and its two
   calls in `demands.ts`; `computedSaid` in `demand-said.ts`; `rehearse-arithmetic.test.ts` and its trees; the proof
   test; the template's loop step 2.

## Drawbacks and alternatives

**What it costs.** A fifth port and six handlers of one line each. One module in the rehearsal, expected to be
about the size of `demand-calls.ts`, and one more kind of node the demand walk knows. The held value adds `probed`, so the
first run's report is kept for the length of the walk instead of discarded.

**Arithmetic in the rule grammar.** Would it be cheaper or better? For the solver it
costs about the same. `demandOf` in `solve.ts` would take a target that is arithmetic over one path and a literal, and
invert it with the same table as here, in `solve.ts` instead of `demands.ts`. A rule over two values
(`b * 100 > max * w`) is as hard in either place: it is an ordering between two paths, which `pairDemands` answers
only where one side is a length, through `measured`'s small search. For `prove.ts` it would be a little better:
`literalTrue` would fold arithmetic over literals through `expr.evaluate` with no new code. For invariants it would be
clearly better: a `holds.when` could say `bold * 100 <= max * words` over a shape's fields, while with this RFC the
ratio must be a field of the shape, written by the graph that makes the value, since an invariant reads only a
shape's fields (`inputsOf` in `check/invariant-holds.ts`). Against that stand the three reasons in *What it does not
do*: a `NaN` in a rule is silent, the consumer needs the number as a value anyway, and the lexer reads `-` as a sign.
Arithmetic in rules can come later without breaking a document: `*` and `/` are a lex error today, so no rule that
parses now changes its meaning.

**Hold the other operand at 1 (or 0) when both can be steered.** No first-run report, no `probed`. Rejected: it fails
on the motivating form. In `margin = activeHundreds − countSixties`, holding `countSixties` at 1 asks
`multiply(count, 60)` for exactly 1, so `count` for 1/60, which no whole number is; holding it at 0 asks for an empty
customer list, where `activeCount` cannot then be 1 once counts are followed (#1036). The value the run
already has keeps the data the case starts from, which is what the rest of the rehearsal does (`overrides`,
`chosen`).

**A small search, as `measured` does for lengths.** Try the held operand at 1, 2 and the ends of its range. It finds
`count = 0` above, with the same problem, and it multiplies the cases tried per arithmetic node. Rejected for the held
value; it may be worth a second look if the held value turns out to miss often.

**`round` with `Math.round` on `a` itself.** `Math.round(-2.5)` is `-2`: it rounds a half toward plus infinity,
which is not half away from zero. And `Math.floor(|a| × m + 0.5)` rounds `0.49999999999999994` to `1`, since the sum
rounds up in doubles. Rejected for both.

**One operation with a static `op` field** (`#compute`, `"op": "*"`). Fewer handlers. Rejected: six names read
plainly in a graph, in `describe` and in the viewer, and each says its own way to fail.

**Each tree writes its own plugin.** That is today's workaround. The checker cannot see the arithmetic, and the
rehearsal can follow it only if it says `pure`, and even then it falls to the stub at the node.

**Integers only.** A tree's numbers are JSON numbers, which are doubles, and the grade the consumer computes is a
fraction. Rejected.

## Open questions

Settled in review on #1035:

1. **`floor` and `round` are in this RFC.** The consumer needs both, and each is one line. `round` rounds half away
   from zero, by the rule in *Rounding*, with a static `digits`; the rule is the definition, so a value that is not
   exact in binary rounds as the rule computes it. Half to even and `ceil` wait for a tree that needs them.
2. **Following `#count` back to its list is not this RFC.** #1027 already decided that a pure operation is never
   stubbed, and that a count still is is a bug against that decision: #1036. This RFC follows its own nodes and does
   not wait for it.
3. **A pure operation the rehearsal cannot follow** reads `NEVER RUN`, as #1027 and the template say. The code that
   stubs it instead is the same bug, #1036.
4. **The names are `@std/number`, `a`, `b` and `digits`.** `@std/list#concat` already names its two operands `a`
   and `b`.
5. **This RFC sits in M14**, the open milestone (one milestone is worked at a time, `CONTRIBUTING.md`), and the
   freeze does not wait for it, since it changes no schema. `docs/roadmap.md` says so in M14's paragraph.

May be decided during implementation:

6. **Should `warmUp` keep its reports too?** `probed` reads only the first run. A node behind a branch the first run
   did not take has no first-run answer, so a held operand there is unknown (*neither known*). The runs `warmUp`
   makes to reach nested switches could fill `probed` as they fill `record`. Decide on whether a test meets the case.
