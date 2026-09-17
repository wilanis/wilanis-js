/**
 * The field form of an invariant: a core shape and a rule its values always satisfy. The rule is judged for
 * itself against the shape's fields (I004), and then at every site a value of the shape comes into being --
 * a node that makes one, a graph that takes one -- where a value written out in literals that contradicts
 * the rule is refused at check time (I005). What is neither proved nor contradicted is guarded, which is
 * the compiler's work (RFC 0007, step 5); this module is what tells it which sites those are.
 */
import { expr, type HoldsInvariant, type InvariantDoc, type Loaded, type ObjField, type Type } from '@wilanis/core';
import { type Site, siteId, sitesOf } from '../sites.js';
import type { Judge, Refuser } from './judge.js';
import { heldAt, literalFields, siteRead } from './prove.js';

/** How a reader is told which invariant judged them: its label where it has one, and the file either way. */
const named = (invariant: Loaded<InvariantDoc>): string =>
  invariant.doc.label ? `'${invariant.doc.label}' (${invariant.path})` : invariant.path;

/**
 * I002, I004 and I005 for one field invariant: the shape is a core shape of this tree, the rule parses and
 * types against its fields, and no site written out in literals contradicts it. Whether it constrains
 * anything at all (I003) is asked here too, since the sites are already in hand.
 */
export function checkHolds(judge: Judge, invariant: Loaded<InvariantDoc>, holds: HoldsInvariant): void {
  new HoldsCheck(judge, invariant, holds).run();
}

class HoldsCheck {
  private readonly refuse: Refuser;

  constructor(
    private readonly judge: Judge,
    private readonly invariant: Loaded<InvariantDoc>,
    private readonly holds: HoldsInvariant,
  ) {
    this.refuse = judge.refuser(invariant.path);
  }

  run(): void {
    const shape = this.shape();
    if (!shape) return;
    const fields = this.inputsOf(shape);
    if (!this.checkRule(fields)) return;
    const sites = sitesOf(this.judge.scope, this.holds.on);
    this.checkReached(sites);
    for (const site of sites) this.checkSite(sites, site);
  }

  /** I002: `on` names a core shape of this tree. An unknown path is R001 and a hidden one L005. */
  private shape(): Type | undefined {
    const at = 'holds/on';
    const target = this.judge.scope.get('shape', this.holds.on);
    if (!target) {
      this.refuse('R001', `unknown shape '${this.holds.on}'`, at, 'wilanis ls shape');
      return undefined;
    }
    this.judge.visible(this.invariant, target, at);
    if (target.doc.layer !== 'core') {
      const message = `holds.on names ${target.doc.layer} shape '${this.holds.on}'`;
      this.refuse('I002', message, at, 'an invariant holds over core shapes; the edge is judged by the trigger');
      return undefined;
    }
    return this.judge.quiet(this.holds.on);
  }

  /** The shape's fields as the rule's inputs: each field a root, an optional field optional. */
  private inputsOf(shape: Type): expr.Inputs {
    const out: expr.Inputs = {};
    if (shape.kind !== 'object') return out;
    for (const [name, field] of Object.entries(shape.fields as Record<string, ObjField>))
      out[name] = { type: field.type, optional: !field.required };
    return out;
  }

  /** I004: the rule parses, types against the shape's fields, and is a boolean. Answers whether it may be used. */
  private checkRule(fields: expr.Inputs): boolean {
    const at = 'holds/when';
    const names = Object.keys(fields).join(', ') || 'none';
    const hint = `the roots are the shape's fields: ${names}`;
    try {
      const type = expr.check(expr.parse(this.holds.when), fields);
      if (type.kind === 'boolean') return true;
      this.refuse('I004', `'${this.holds.when}' is ${type.kind}, not boolean`, at, hint);
    } catch (error) {
      this.refuse('I004', (error as Error).message, at, hint);
    }
    return false;
  }

  /** I003: some graph makes or takes a value of the shape. An invariant no value is ever judged by holds nothing. */
  private checkReached(sites: Site[]): void {
    if (this.invariant.included || sites.length) return;
    const message = 'no graph makes or takes a value of this shape, so this invariant holds nothing';
    this.refuse('I003', message, 'holds/on', 'remove it, or name a shape a graph makes or takes');
  }

  /**
   * I005: a site whose every read is literal comes out false. The refusal is against the graph rather than the
   * invariant: the value written there is what is wrong, and the invariant is what says so.
   */
  private checkSite(sites: Site[], site: Site): void {
    for (const values of this.contradictions(sites, site)) {
      const at = site.node ? `nodes/${site.node.id}` : 'in';
      const message = `the value '${siteId(site)}' makes contradicts ${named(this.invariant)}: ${this.says(values)}`;
      const hint = `the value contradicts '${this.invariant.doc.label ?? this.invariant.path}' (${this.invariant.path}): ${this.holds.when}`;
      this.judge.refuser(site.graph.path)('I005', message, at, hint);
    }
  }

  /** For each conjunct a site writes out in literals and that comes out false, the values that made it so. */
  private contradictions(sites: Site[], site: Site): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    if (!site.node) return out; // a taken value is the caller's; nothing is written here to contradict
    const read = siteRead(this.judge.scope, sites, site);
    for (const [conjunct, proof] of heldAt(this.judge.scope, sites, site, this.holds.when)) {
      if (proof.by !== 'guarded') continue; // established, so it never comes out false here
      const values = literalFields(read, conjunct);
      if (values && !expr.evaluate(conjunct, values)) out.push(values);
    }
    return out;
  }

  /** What a refusal says the site wrote: every field the conjunct that came out false reads, as it stands there. */
  private says(values: Record<string, unknown>): string {
    const wrote = Object.entries(values).map(([name, value]) =>
      value === undefined ? `${name} is absent` : `${name} = ${JSON.stringify(value)}`,
    );
    return `'${this.holds.when}' is false where ${wrote.join(', ')}`;
  }
}
