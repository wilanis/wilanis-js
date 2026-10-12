# RFC 0040: `contains`: a rule asks whether a text holds a word written in the rule

- **Status:** accepted
- **Areas:** `area:core` (the expression grammar under `packages/core/src/expr/`; the descriptions of
  `switch.schema.json` and `invariant.schema.json`), `area:runtime` (the branch solver: `solve.ts`, `domains.ts`,
  `stubs.ts`; the template's `CLAUDE.md`), `area:view` (`said.ts`). The compiler changes by one comment:
  `prove.ts` already reasons over the new operator through `expr.evaluate` and its canonical spelling. Nothing in
  the engine, nothing in a plugin.
- **Tracking issue:** #856
- **Depends on:** RFC 0007 (implemented: invariants, the guard, `prove.ts`), RFC 0018 (implemented: the branch
  solver the rehearsal steers with).

## Summary

A rule may say `email contains '@'`: true when the text holds the word, exactly as written. It is one more binary
operator of the one expression grammar, so it works wherever a rule is written: a `switch` rule, an invariant's
`holds.when`, a `retry.when`, an operation's `idempotent`, and, once RFC 0039 lands, a `map`'s `where`. The right side is always a non-empty string literal,
never a path. The match is case-sensitive and compares characters as JavaScript's `String.prototype.includes`
does, which is what `contains` already means in `@storage`'s `where` grammar. The checker proves it where the
text is a literal (I005 refuses a literal that fails it), a `switch` that tested the same words proves it for
the node it routes to, and the rehearsal's solver makes a text that holds the word or lacks it, so both branches
of a rule are rehearsed. Regular expressions stay out: no solver can make a witness for every one, `prove.ts`
cannot compare two of them, and one written badly can stall a run on a caller's text. A rule over a list of words
kept elsewhere ("no text names any private name") stays with a plugin that counts the hits, and the rule holds
the count to zero.

## Motivation

The rule language cannot look inside a text. `evaluate` in `packages/core/src/expr/evaluate.ts` knows
comparisons, `&&`, `||`, `!`, `in` over a list, `has()` and `len()`. `check` in `packages/core/src/expr/check.ts`
refuses `in` with a string on its right (`membershipType`: "in looks into a list, not string"). So an author who
wants "an email address holds an `@`" or "a slug holds no space" has two ways today, and both cost more than the
rule:

1. **A plugin answers a number or a boolean, and the rule reads it.** This is the pattern of #791 ("value-level
   decisions in graphs, mechanical work in generic plugins"). The plugin is a package with a handler, a port
   document and tests. The graph gains a node, and the rule reads the node's answer instead of the field. An
   invariant cannot read a node's answer: its roots are the fields of one shape (`inputsOf` in
   `packages/compiler/src/check/invariant-holds.ts`), so the count must be a field of the shape, written by the
   graph that makes the value.
2. **No rule.** The tree trusts every text, and `wilanis check` says nothing.

A consumer tree met this (its `GAPS.md`, "Item 12: a rule cannot match text"): "Needed: a rule that tests whether
a text holds a word or matches a pattern (a private name in a page write). Wilanis lacks: `contains` or `match`."
It took the first way. Its plugin `@confluence` counts the written texts that name a private name, and the tree's
invariant `writes-name-nothing-private.invariant.json` holds the count to zero:

```json
"holds": {
  "on": "@pages/domain/Plan.shape.json",
  "when": "privateHits == 0 && links == 0"
}
```

**This RFC does not close that consumer's case, and says so.** Its matching is not a literal `contains`. The
setting `private` in its `plugins/confluence/docs/plugin.json` says the names match "case aside, and read with
entities decoded (h&#112; is hp) and with and without invisible characters: a short name of letters only (three
or fewer, such as hp) matches where no letter stands right before or after it (hp1, hp_lan, hp-01, the HP's;
never http)", and a private network address counts as a name too. A literal `body contains 'hp'` would match
`http` and miss `HP`. The names are also a list kept in a plugin setting, and a rule reads no setting. That part
stays with the plugin; "What it does not do" below says why.

What the RFC does close is the language gap itself: a rule over a fixed word, written by the author, in the tree,
where the checker and the rehearsal see it. `@storage` already lets a filter say `{ "email": { "contains":
"example.com" } }` (`packages/plugin-storage/src/where.ts`, RFC 0002), so a tree can ask a store which records
hold a word, and cannot ask the same question of a value in a rule.

## Guide-level explanation

**`contains`** sits between a text and a word: `email contains '@'`. It is true when the text holds the word
anywhere, exactly as written. Case counts: `'Ada' contains 'ada'` is false. The word is always written in the
rule, in quotes. It is never a field: `email contains domain` is refused, because the checker and the rehearsal
reason only about words they can read in the rule.

`!(note contains 'http')` is true when the text does not hold the word. Write the parentheses: `!` binds to the
comparison after it, as it does for `==` today, and the parentheses make that plain to a reader.

`contains` reads a text, and a read of an optional field needs `has()` first, as every read does:
`has(note) && note contains 'VIP'`. `contains` never looks into a list; `'admin' in roles` does that.

### In an invariant

The example's `Customer` gets a second rule, beside `a-customer-is-reachable.invariant.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/invariant.schema.json",
  "label": "An address names its domain",
  "description": "An email address holds an @, so a customer is never kept with a name where the address should be.",
  "holds": {
    "on": "@customers/domain/Customer.shape.json",
    "when": "email contains '@'"
  }
}
```

The compiler judges it at every site that makes or takes a `Customer`, as it judges every field invariant
(RFC 0007):

- Where the site writes `email` as a literal, the checker evaluates the rule. A literal that holds no `@` is a
  refusal:

  ```
  I005  @features/customers/domain/register-customer.graph.json#nodes/customer
      the value 'customer' makes contradicts 'An address names its domain' (@customers/domain/an-address-names-its-domain.invariant.json): email = "ada.example.com"
      → the value contradicts 'An address names its domain' (@customers/domain/an-address-names-its-domain.invariant.json): email contains '@'
  ```

  (`register-customer` reads its `email` from the request today; the refusal shows what a graph that wrote it as
  a literal would meet.)

- Where a `switch` routing to the site already tested `email contains '@'` about the same value, the site is
  proved, and no guard is lowered there.
- Everywhere else the compiler lowers the guard, and `wilanis rehearse` reports both of its branches:

  ```
  features/customers/domain/register-customer  guard 'customer:check' A customer is reachable; An address names its domain  3/3 branches
    ok  holds     answered from 'customer'
    ok  violated  refused on purpose at 'customer:violated' as invariant: "'A customer is reachable' does not hold: len(name) > 0 && ..."
    ok  violated  refused on purpose at 'customer:violated:2' as invariant: "'An address names its domain' does not hold: email contains '@'"
  ```

  The `holds` case runs with an email the solver made to hold `@`; the case that reaches `customer:violated:2`
  runs with one made to lack it. (The lines follow `rehearsal-report.ts` today: a guard of two invariants joins
  their labels with `; `, and every branch but the value reads `violated`.)

### In a switch

```json
{
  "id": "byDomain",
  "switch": true,
  "in": { "email": "{{in.email}}" },
  "rules": [{ "when": "email contains '@example.com'", "to": "internal" }],
  "else": "external"
}
```

The viewer says the rule in words: `if email contains "@example.com"`.

### What a wrong rule looks like

```
I004  @features/customers/domain/an-address-names-its-domain.invariant.json#holds/when
    contains looks for a word written in the rule, as email contains '@', not for 'name'
    → the roots are the shape's fields: id, name, email, tier, registrar, active, note
```

The same message comes through G011 for a `switch` rule, G019 for a `retry.when`, and C015 for an `idempotent`
rule. Where RFC 0039 (draft, #919) lands, a `map`'s `where` is one more such place: `"where": "item.email contains
'@'"` keeps the elements whose address holds an `@`, a wrong `contains` there is G011 at `nodes/<id>/where`, and
the rehearsal steers its *kept* and *dropped* branches with the same solver. No new code is needed: each of those codes already says "this expression does not type".

## Reference

### Documents and schemas

No new field and no new kind. The rule fields stay strings. Two descriptions change, so that a reader of the
schema learns the operator exists:

- `packages/core/schemas/node/switch.schema.json`, the top-level description: "Expressions: has(path),
  comparisons, && || !, len(x)" becomes "Expressions: has(path), comparisons, x in list, text contains 'word',
  && || !, len(x)".
- `packages/core/schemas/invariant.schema.json`, `holds.when`: "has(), len(), comparisons, in, &&, ||, !" gains
  "contains".

`common.schema.json` (`retry.when`) and `port.schema.json` (`idempotent`) say "in the grammar of a switch rule"
and do not list the operators, so they do not change.

This is a change under `packages/core/schemas/`, so the implementing pull request waits on the maintainer's
`decision` job. It is compatible under RFC 0008: every document that validated before still validates and means
the same thing.

### The grammar

`packages/core/src/expr/ast.ts`: `BinaryOp` gains `'contains'`. The grammar comment becomes:

```
cmp := primary (('=='|'!='|'<'|'<='|'>'|'>='|'in'|'contains') primary)?
```

`packages/core/src/expr/lex.ts`: no change. `contains` lexes as an identifier, as `in` does.

`packages/core/src/expr/parse.ts`: `comparison()` takes the word `contains` after a primary, as it takes `in`. A
field named `contains` stays a field: `contains.x contains 'a'` reads the path `contains.x`, as `in.roles` reads
the path `in.roles` today. No expression that parsed before changes meaning, because `<primary> contains ...` was
"trailing tokens" before.

`packages/core/src/expr/check.ts`: `binaryType` sends `contains` to a new `containsType(left, expr.right)`. It
answers `BOOLEAN`, or throws an `ExprError`:

| The rule | The message |
|---|---|
| the left is not a string (and not `unknown`) | `contains looks into a string, not <type>`; for a list it adds `-- 'x' in list asks whether a list holds a value` |
| the right is not a literal | `contains looks for a word written in the rule, as email contains '@', not for '<path>'` |
| the right is a literal that is not a string | `contains looks for a string, not <type>` |
| the right is `''` | `contains '' holds for every text; write the word to look for` |

The left may be any expression that types as a string. Today that is a path or a string literal. A literal on
the left (`'abc' contains 'b'`) is accepted, as `1 == 1` is.

`packages/core/src/expr/evaluate.ts`: `evaluateBinary` answers `typeof left === 'string' && left.includes(right)`.
A left that is not a string at run time (a value typed `unknown`) answers `false`, as `in` answers `false` for a
right that is not a list.

### Why the right side is a literal

The right side is a non-empty string literal, and the checker refuses anything else. Three reasons:

1. **The solver.** `solve` in `packages/runtime/src/solve.ts` turns each comparison into a demand on one path
   (a `Domain`). A literal word gives one demand: this path holds `'@'`, or lacks it. A path on the right would
   relate two values, as `a == b` does. The solver meets two values only in `pairDemands`
   (`packages/runtime/src/solve-pairs.ts`): `==` and `!=` between two values, one way, and a length only at 1 or
   2. For anything else `whyUnsolved` says "the solver cannot compare two paths". `a contains b` would need a new
   relation there (make `b` a part of `a`, or make `a` avoid `b`), and its negation over generated values.
   `containment` is tried before `pairOf`, so a rule that reached the solver with a path on the right would
   still answer no alternative rather than a wrong one.
2. **The proof.** `prove.ts` proves a conjunct from literals (`literalTrue`) or from the same words a switch
   tested (`narrowedBy`, through `same` and `spell`). A literal word keeps both of those exact. A path on the
   right would be proved only where both sides are literals at the site, which is where a rule is least needed.
3. **The need.** Every case seen so far is a fixed word: an `@`, a scheme, a marker that must not be written. A
   word that changes per run is a value, and comparing two values is a graph's work.

A path on the right can be allowed later without breaking a document: a refusal becomes an acceptance.

### Ports, operations and kinds granted

None.

### Checker rules

No new code. The table names the existing codes that meet the new operator.

| Code | Where it lives | What changes |
|---|---|---|
| G011 | `check/graph-nodes.ts` (`checkRule`) | a switch rule with a wrong `contains` is refused with the `ExprError` message above; where RFC 0039 lands, a map's `where` too (`checkWhere`, at `nodes/<id>/where`) |
| I004 | `check/invariant-holds.ts` (`checkRule`) | the same for `holds.when` |
| G019 | `check/attempts.ts` | the same for `retry.when` |
| C015 | `check/contracts.ts` (`notBoolean`) | the same for an `idempotent` rule |
| I005 | `check/invariant-holds.ts` (`checkSite`) | a site that writes the text as a literal is evaluated through `expr.evaluate`, so a literal that fails `contains` is refused; no code change |

**`prove.ts`.** No code change. The three rules of `packages/compiler/src/check/prove.ts` meet `contains` as
follows:

- *literal*: `literalTrue` evaluates the conjunct with `expr.evaluate`, which now knows `contains`.
- *narrowed*: `implies` compares spellings first (`spell` writes `(email contains "@")`), so a switch that tested
  the same words proves the conjunct, and `!(note contains "http")` proves itself the same way. The implication
  table adds no row. `stronger` already answers `false` for an operator it does not list, so `email contains
  '@x'` does not prove `email contains '@'`, and `email == 'a@b'` does not prove `email contains '@'`. Both are
  true, and both are left to the guard, in the spirit of the module's own comment: "Deliberately no arithmetic on
  the literals." A substring test between two literals is the same kind of reasoning.
- *through*: unchanged; it never reads the rule.

The module comment says that `contains` is proved only by the same words, and a test in
`packages/runtime/test/invariant-proof.test.ts` holds it.

### Runtime behaviour

**The kernel.** A `switch` rule and a guard run `expr.compilePredicate`, which runs `evaluate`. Nothing else
changes.

**The solver** (`packages/runtime/src/solve.ts`, `domains.ts`, `stubs.ts`). This is what RFC 0018's witness
generation needs, so that the rehearsal can steer both branches of a `contains` rule, and can steer every other
guard to the branch that answers (`answering` in `rehearse-reached.ts`). Without it, a rule such as
`email contains '@'` would send every rehearsed run through the guard's refusal, since generated words
(`generate` in `packages/core/src/generate.ts`) never hold an `@`.

- `Domain` gains two fields: `contains?: string[]`, the words the text must hold, and `omits?: string[]`, the words
  it must not hold.
- `compare` in `solve.ts` sends `contains` to a new `containment(node, want)`, beside `membership`. With a path on
  the left and the literal on the right it answers `{ [path]: { contains: [word], present: true } }` when `want`,
  and `{ [path]: { omits: [word] } }` when not. Like `lacks` and `ne`, `omits` does not demand presence. A left
  that is not a path answers no alternative, and `nameableBin` says so, so the branch reads "compares values the
  rehearsal cannot name".
- `narrow` in `domains.ts` joins the two lists, as `narrowMembers` joins `has` and `lacks`. `contains` implies
  `present`, so it contradicts `absent`.
- `consistent` answers `false` (UNSAT) when an omitted word is part of a word the text must hold (`contains 'ab'`
  and `omits 'b'`), or when a word the text must hold is longer than `maxLen`. An exact value (`eq`) is checked
  by `fits`, which now tests `contains` and `omits` against a string value: `email == 'ada' && email contains
  '@'` is UNSAT.
- `satisfy` in `stubs.ts` gains one entry in `DEMANDS`, after `paired`, met by a new `withWords`:
  1. For a string with an `enum`, the first member that `fits` the domain, or `NO_MEMBER` (the rehearsal reports
     `exhausted`, as it does today for an enum the demand empties).
  2. Otherwise it starts from the generated text, or a fresh one of the type.
  3. It removes each omitted word, again until none is left (`'hhpp'` without `'hp'` is `''`, not `'hp'`).
  4. It appends each word the text must hold and does not, after a space.
  5. It pads to `minLen` with the placeholder, as `withChars` does.
  6. It checks the result with `fits`. Where the result fails (an append made an omitted word across the join),
     it tries the words alone, joined by a space. Where that fails too, it answers `NO_MEMBER`. A value the
     solver cannot build is reported, never run.
  `NO_MEMBER`'s comment widens from "no member of the enum is left" to "no value of the type meets the demand".
  Its name may change in the same pull request.

**`fuzz` and `fuzz --edges`.** No change. Edges are fixed (RFC 0018: "no edge derived from a `pattern`"), so a
generated `email` of `echo` is refused by the guard and recorded as refused. That is the true answer for that
input.

**`regress`.** No change; it replays what was recorded.

### Discoverability

- **The viewer.** `VERB` in `packages/view/src/said.ts` is a `Record` over every comparing operator, so the new
  operator is a type error there until it has its words: `contains: ['contains', 'does not contain']`. A rule
  then reads `if email contains "@"`, and under `!` `if note does not contain "http"` (a literal is shown as JSON,
  as `clause` shows every literal today).
- **`describe`, `map`, `ls`.** They print a rule's text as written, so they show `contains` with no change.
- **The template.** `packages/runtime/templates/CLAUDE.md` gains a line beside **Membership**: "**Text.**
  `email contains '@'` is true when the text holds the word exactly as written: case counts, and the word is a
  literal in the rule, never a field. A rule over words kept in a setting, or matched case aside, is a plugin's
  to count; the rule then holds the count to zero."
- **The model.** `docs/model.md`, beside "`in` looks into a list", says the same in one sentence.

### Plugin contract

None.

## What it does not do

- **No regular expressions, and no `matches`.** A regular expression breaks the three things a rule must allow:
  1. *Witnesses.* The solver must make a text that matches a pattern, a text that does not, and texts that meet
     several patterns and length bounds at once. For JavaScript's patterns (back-references, look-arounds) that
     is not decidable in general, and for plain ones it needs automata the solver does not have.
  2. *Proof.* `prove.ts` would have to decide whether one pattern implies another. That is language inclusion,
     which is expensive even for plain patterns and undecidable with back-references. Every such site would be
     guarded, so a pattern would never be proved.
  3. *Run time.* A guard runs the rule on every value made at the site, and that value often comes from the
     caller. A pattern with catastrophic backtracking stalls the event loop on a crafted text, so a rule would
     become a way to deny service. And the pattern dialect (ECMAScript's) would become part of IR v1, binding
     every future runtime to it.
  A tree that needs a pattern keeps the #791 shape: a pure plugin operation answers whether the text matches, and
  the rule reads the answer. The plugin owns the pattern, its dialect and its tests.
- **No `startsWith` or `endsWith`.** `@storage`'s `where` has `startsWith`, so the word exists in the tree's
  vocabulary. It would cost the same as `contains`: one demand kind, one verb, a few tests. No tree has needed it
  yet. Open questions says how to add it.
- **No case folding, no Unicode normalisation, no word boundaries.** `contains` compares code units. `'Café'` with a
  composed `é` does not contain `'é'` written as `e` and a combining accent. A rule that must match case aside or
  by word is a plugin's, which can say what "a word" means for its texts.
- **No list of words kept elsewhere, and no quantifier.** The consumer's wider need (its `GAPS.md`, "Item 23 (f)",
  and the `private` setting of Item 12) is "no text in this plan names any of a list of names kept in a setting".
  That needs two things this RFC does not add, and it stays with a plugin:
  1. *A root that is not a field.* A rule reads the fields of its shape (an invariant) or a node's inputs (a
     switch). A list in a plugin setting or a project constant is neither. Reading one is an amendment to RFC
     0007: the grammar gains a non-field root, and `prove.ts` must reason about a value that differs per profile,
     since settings do.
  2. *A quantifier.* "Any text of `writes[]` names any name of `private[]`" needs `any`/`all` over lists with a
     bound variable. The solver would have to build lists of witnesses, and the narrowing would have to track
     what a switch proved about every element. That turns the rule language into a small programming language,
     which RFC 0007 kept it from being ("in the grammar a `switch` rule already uses").
  3. *A matching rule of its own.* As the Motivation shows, the consumer's names match case aside, with entities
     decoded and with word boundaries for short names. That is code with unit tests, not a literal.
  So the plugin counts, and the invariant holds the count to zero. The list has one home (the setting), the
  matching has one home (the plugin's code and tests), and `wilanis check` judges the count where the value is
  made. The triage of that consumer's gaps reached the same answer for Item 23 (f): "the `@jira` contract gate
  is acceptable. An RFC 0007 amendment is L."
- **No new reading of `in`.** `'@' in email` stays a type error; see the alternatives.
- **No rule over an optional field's absence or its words in one go.** `!has(note) || !(note contains 'http')` is
  refused, because `has()` proves presence only on the left of `&&` (`provedBy` in `check.ts`). That is true of
  every read today, `len(note)` included, and is not this RFC's to change.

## Compatibility

IR v1: two schema descriptions change; no field, no kind, no `$id`. Every document that validated before still
validates. Every rule that parsed before parses to the same tree, since `<primary> contains ...` did not parse
before. A rule that reads a field named `contains` keeps reading it. This is a compatible change under RFC 0008
before and after 1.0, so it does not need to land before the `schemas-v1` freeze.

## Tests

**Core** (`packages/core/test/expr.test.ts`, a `describe('contains')` beside `membership`):
- `email contains '@'` parses to a `bin` with op `contains`, types `BOOLEAN`, and evaluates `true` for `'a@b'`,
  `false` for `'ab'`, and `false` for a number.
- each refusal in the table above throws an `ExprError` with its message: a list on the left, a number on the
  left, a path on the right, a number on the right, `''` on the right.
- `contains.x contains 'a'` reads the path `contains.x`.
- `!(email contains '@')` and `has(note) && note contains 'x'` type; `note contains 'x'` over an optional `note`
  is refused with the existing "may be missing" message.

**Solver** (`packages/runtime/test/rehearse-solver.test.ts`, `rehearse-stubs.test.ts`):
- `branchesOf([{ when: "email contains '@'", to: 'a' }], 'b')` gives a rule case demanding `contains: ['@']` and an
  else case demanding `omits: ['@']`.
- `email contains 'ab' && !(email contains 'b')` is unsolved as a contradiction; `email == 'x' && email contains
  '@'` too.
- `satisfy` makes `'echo @'` from `'echo'` for `contains: ['@']`, `''` from `'hhpp'` for `omits: ['hp']`, the
  first fitting member of an enum, and `NO_MEMBER` for an enum no member of which fits.

**Proof** (`packages/runtime/test/invariant-proof.test.ts`):
- a site writing `email` as the literal `'a@b'` is `literal`; as `'ab'` is refused I005 (the sabotage below).
- a site behind a switch that tested `email contains '@'` is `narrowed`; behind one that tested `email contains
  '@x'` or `email == 'a@b'` is `guarded`.

**Viewer** (`packages/view/test/graphs.test.ts`): a switch with `email contains '@'` says `if email contains "@"`,
and one with `!(email contains '@')` says `if email does not contain "@"`.

**The example** (`packages/runtime/test/example.test.ts`, `sabotage-invariants.test.ts`):
- the example carries `an-address-names-its-domain.invariant.json`, `wilanis check example` passes, and
  `wilanis rehearse example` reports the customer guards with every branch rehearsed and none unsolved.
- sabotage: the invariant's rule becomes `email contains name` → I004 with "not for 'name'".
- sabotage: a graph writes a `Customer` whose `email` is the literal `"ada.example.com"` → I005.
- sabotage: a switch rule becomes `tier contains ''` → G011.

## Implementation plan

Each step is one pull request and one sub-issue, and each leaves `npm test` passing.

1. **Core and viewer: the operator.** `ast.ts`, `parse.ts`, `check.ts`, `evaluate.ts` and their tests; the
   `VERB` row in `packages/view/src/said.ts` and its test (the build fails without it); the two schema
   descriptions, so this step waits on the `decision` job. The step also makes the solver refuse to guess:
   `compare` in `solve.ts` answers `[]` for `contains`, and `nameableBin` answers `false`, before anything else.
   Without those two lines a `contains` rule would fall through on `main` today: `compare` would take the
   operator as a `Cmp`, `demandOf` would call `valueDomain`, and for a string literal that answers `{ ne: [] }`,
   a demand that constrains nothing; `nameableBin` would answer `true` for a path against a literal. Both
   branches would then read as solved, and the rehearsal would run them with values that do not meet the rule.
   With the two lines, until step 2 a rehearsal reports each branch of a `contains` rule unsolved ("compares
   values the rehearsal cannot name"), which is true. A test in `rehearse-solver.test.ts` holds it. No tree in the
   repository uses the operator yet. A good first issue, with the design above.
2. **Runtime: the solver.** `containment` in `solve.ts`, which replaces step 1's `[]`, and `nameableBin`
   answering `true` for a path against a literal; `contains` and `omits` in `domains.ts`
   (`narrow`, `consistent`, `fits`); `withWords` in `stubs.ts`; their tests.
3. **The example, the proof tests and the words.** The invariant in `example/`, re-recorded `example/scenarios/`
   (the generated emails gain an `@`, and the guard gains a refusal), the sabotage cases, the proof tests, the
   comment in `prove.ts`, the template's **Text** line and the sentence in `docs/model.md`.

## Drawbacks and alternatives

**Do nothing; teach the workaround.** The #791 shape works today: a pure plugin answers a count or a boolean,
and the rule reads it. It is the right answer for a pattern, a list kept elsewhere, or a match case aside. For a
fixed word it costs a package, a node and an extra field, and it hides the word from the checker: a literal text
that holds the forbidden word is not refused by I005, because the checker cannot see into the plugin. The
template would also have to teach the workaround, which is longer than the operator. The cost of the operator is
small (one AST op, about 20 lines in the checker and the evaluator, one demand kind in the solver), and it fits
a word the tree already uses in `where`. I recommend adding it. The honest drawback is that the consumer that
asked is not served; the RFC is worth it only if the maintainer expects fixed-word rules in other trees, and the
`where` grammar suggests that it does.

**Read `in` over a text: `'@' in email`.** No new word, and `membership` in the solver already exists. Rejected:
`in` over a value typed `unknown` would mean "is an element of" or "is a part of" depending on the value at run
time, so the rule's meaning would not be fixed by the document. The solver would have to know the type to choose
between `has` (a list) and `contains` (a text), and it does not see types (`Demands` are keyed by path). The
viewer's "is among" would be wrong for a text. And `where` already uses `contains` for this.

**A call: `contains(email, '@')`.** It reads like `has()` and `len()`. Rejected: the lexer has no comma, and a
call with two arguments is a new form in the grammar. The infix form reads as a sentence and parses exactly as
`in` does.

**A path on the right.** Rejected for now; see "Why the right side is a literal".

**Case folding (`containsCaseAside`, or a flag).** Rejected: which folding (ASCII, Unicode simple, locale) is a
choice a plugin can make for its texts and the IR should not. The solver would have to fold too.

**`startsWith` in the same step.** It costs little and mirrors `where`. Left out because no tree needs it yet;
see Open questions.

## Open questions

- **`startsWith` now or later?** Decided on review: later. An amendment to this RFC adds it when a tree uses it.
  It is one more `BinaryOp`, a `prefix` demand (prepend the word; remove it where it must not lead), one `VERB`
  row.
- **The example's demonstration.** Decided on review: the new invariant on `Customer` (`email contains '@'`),
  not a switch. It exercises the solver on both sides, the proof, and I005, in a tree that already has a guarded
  `Customer`. The cost is a re-record of `example/scenarios/`, since generated emails gain an `@`.
- **The name of `NO_MEMBER`.** It may be decided during implementation.
