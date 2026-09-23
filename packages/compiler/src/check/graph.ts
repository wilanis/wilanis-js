/**
 * G graphs. Node ids are free and unique (G001); every node runs an operation this graph's role may run
 * (L002, L003, L008); inputs fit their contracts (see inputs.ts); a switch's rules are boolean and route to
 * nodes of this graph, each routed once (G009, G011); a map iterates a list and binds its element (G012); no
 * cycle (G007); out.from names nodes that answer the out type (G010); everything declared is read (G008,
 * and P005 for the `reads` map); an effect no switch routes is read on every branch (G015); no read is named
 * after a node (P006); constants conform (G013). A domain graph that only forwards its input is refused (L007),
 * and writes no retry or timeout (L012) and catches nothing (L013); a data graph's retry is judged in attempts.ts
 * (G017, G018, G019), and what its switches catch in graph-nodes.ts (G021 to G024).
 */
import {
  conforms,
  type GraphDoc,
  type GraphRole,
  isMap,
  isRun,
  isSwitch,
  type Loaded,
  type MapNode,
  type Node,
  type OpHit,
  type RunNode,
  type SwitchNode,
  show,
  type Type,
} from '@wilanis/core';
import { outputCandidates } from '../documents.js';
import { answersOf, checkCallRetry } from './attempts.js';
import { checkCatches, checkReason, checkSwitch, elementInputs } from './graph-nodes.js';
import { GraphReads } from './graph-reads.js';
import { checkWhole } from './graph-whole.js';
import { checkInputs } from './inputs.js';
import { type Effects, type Judge, type JudgedResolver, RESERVED, type Refuser, type ShapeLayer } from './judge.js';
import { resolversFor } from './resolvers.js';

/**
 * Every refusal a graph can earn, in the role its layer gives it: unique ids (G001), operations the role and
 * the feature may run (L002, L003, L008), reads that resolve (G003), inputs that fit their contracts, switches
 * and maps (G004, G006, G009, G011, G012), conforming constants (G013), a `reads` map naming no node of the
 * graph (P006) and every entry of which is read (P005), and the whole (G007, G008, G010).
 * A domain graph that only forwards its input to one port operation is refused as boilerplate (L007).
 */
export function checkGraph(judge: Judge, graph: Loaded<GraphDoc>, role: GraphRole): void {
  new GraphCheck(judge, graph, role).run();
}

/**
 * L007. A domain graph earns its place by doing something the port call alone cannot: composing more than one
 * node, routing, mapping, or supplying a value the caller never gave. One node that forwards its input to one
 * port operation is boilerplate between the trigger and the binding -- the trigger fires the port.
 */
function checkNotPassThrough(judge: Judge, graph: Loaded<GraphDoc>): void {
  const doc = graph.doc;
  if (doc.nodes.length !== 1) return;
  const node = doc.nodes[0];
  if (!isRun(node)) return;
  if (Object.keys(doc.constants ?? {}).length || doc.reads) return;
  const hit = judge.scope.op(node.run);
  if (typeof hit === 'string' || hit.port.native) return;
  // every input forwarded one-for-one from the graph's own in, and nothing added
  const forwards = Object.entries(node.in ?? {}).every(([name, value]) => value === `{{in.${name}}}`);
  if (!forwards) return;
  const hint = `it adds no rule of its own; fire ${node.run} from the trigger and delete this graph`;
  judge.refuser(graph.path)('L007', `graph only forwards its input to '${node.run}'`, undefined, hint);
}

class GraphCheck {
  readonly refuse: Refuser;
  private readonly file: string;
  private readonly layer: ShapeLayer;
  private readonly effects: Effects;
  readonly nodes = new Map<string, Node>();
  private readonly ops = new Map<string, OpHit>();
  readonly routedBy = new Map<string, string>();

  constructor(
    private readonly judge: Judge,
    private readonly graph: Loaded<GraphDoc>,
    private readonly role: GraphRole,
  ) {
    this.file = graph.path;
    this.refuse = judge.refuser(graph.path);
    this.layer = role === 'data' ? null : 'core';
    this.effects = judge.effectsOf(graph.feature);
  }

  run(): void {
    const doc = this.graph.doc;
    if (this.role === 'domain') checkNotPassThrough(this.judge, this.graph);
    const resolvers = resolversFor(this.judge, doc.reads, this.graph, this.role === 'data');
    const inType = this.judge.type(doc.in, this.file, 'in');
    if (doc.in) this.judge.checkLayer({ spec: doc.in, from: this.graph, at: 'in', layer: this.layer, what: 'in' });
    if (doc.out)
      this.judge.checkLayer({ spec: doc.out.type, from: this.graph, at: 'out/type', layer: this.layer, what: 'out' });
    const outType = this.judge.type(doc.out?.type, this.file, 'out/type');
    const constTypes = this.checkConstants();
    this.collectNodes();
    const reads = new GraphReads(this.judge, {
      file: this.file,
      nodes: this.nodes,
      ops: this.ops,
      resolvers,
      inType,
      constTypes,
    });
    this.checkReadNames(resolvers);
    for (const node of this.nodes.values()) this.checkNode(node, reads);
    if (this.role === 'data') this.checkCatches(reads);
    this.checkReadsUsed(resolvers, reads);
    reads.checkEffectsRouted(this.routedBy, outputCandidates(doc) ?? []);
    checkWhole({ refuse: this.refuse, doc, routedBy: this.routedBy, reads, outType });
  }

  /**
   * P006: a read's local name is the author's, so it may collide with a node's id -- {{name}} would be
   * ambiguous, and the order `rootReadRaw` tries the roots in would decide it silently. The name is refused
   * instead, and the order never matters. This half is the graph's alone, since only a graph has node ids;
   * the half about the roots every document reads is `readFor`'s, so a binding and a store earn it too.
   */
  private checkReadNames(resolvers: Record<string, JudgedResolver>): void {
    for (const name of Object.keys(resolvers)) {
      if (!this.nodes.has(name)) continue;
      this.refuse(
        'P006',
        `'${name}' is also the id of a node; {{${name}}} would be ambiguous`,
        `reads/${name}`,
        `rename the read: "reads": { "${name}By": "...#${name}" }`,
      );
    }
  }

  /**
   * P005: `reads` is exactly what this graph reads, so an entry no value reads is refused as an unused import
   * is. What was read is what the nodes' values named; an entry P004 already refused is not judged twice.
   */
  private checkReadsUsed(resolvers: Record<string, JudgedResolver>, reads: GraphReads): void {
    for (const name of Object.keys(resolvers)) {
      if (reads.readsResolvers.has(name)) continue;
      const hint = `read it as {{${name}}}, or drop the entry: reads is exactly what this document reads`;
      this.refuse('P005', `'${name}' is used by no value of this graph`, `reads/${name}`, hint);
    }
  }

  // ---- the table ----------------------------------------------------------------------------------

  /** G013: a constant conforms to its type. Answers the type each is read as: a string literal as its own enum. */
  private checkConstants(): Record<string, Type> {
    const types: Record<string, Type> = {};
    for (const [name, constant] of Object.entries(this.graph.doc.constants ?? {})) {
      const type = this.judge.type(constant.type, this.file, `constants/${name}/type`);
      if (!type) continue;
      const bad = conforms(constant.value, type);
      if (bad)
        this.refuse(
          'G013',
          `constant '${name}' does not conform to ${show(type)}: ${bad}`,
          `constants/${name}/value`,
          "write a value of that type, or change the constant's type",
        );
      const literal = type.kind === 'string' && typeof constant.value === 'string';
      types[name] = literal ? { kind: 'string', enum: [constant.value as string] } : type;
    }
    return types;
  }

  /** G001: ids are free and unique; every run names an operation this graph may run. */
  private collectNodes(): void {
    for (const node of this.graph.doc.nodes) {
      if (RESERVED.has(node.id))
        this.refuse(
          'G001',
          `node id '${node.id}' is reserved`,
          `nodes/${node.id}`,
          `rename the node; ${[...RESERVED].join(', ')} are roots a read may name`,
        );
      if (this.nodes.has(node.id)) {
        this.refuse('G001', `duplicate node id '${node.id}'`, `nodes/${node.id}`, 'give each node an id of its own');
        continue;
      }
      this.nodes.set(node.id, node);
      this.checkFits(node);
    }
  }

  /** What a node may be in this role: a domain graph's switch catches nothing (L013); a call runs what the role may run. */
  private checkFits(node: Node): void {
    if (isSwitch(node)) {
      if (this.role === 'domain' && node.catch) this.refuseCatch(node);
      return;
    }
    const hit = this.judge.opAt(node.run, this.graph, `nodes/${node.id}/run`);
    if (!hit) return;
    this.ops.set(node.id, hit);
    this.checkOperationFits(node, hit);
  }

  /**
   * What a graph of this role may run: a domain graph no effect (L002), a data graph natives only (L002) and
   * only the effects its feature allows (L003); nothing that holds (L008), since what it starts outlives the run.
   */
  private checkOperationFits(node: RunNode | MapNode, hit: OpHit): void {
    const at = `nodes/${node.id}`;
    const key = `${hit.path}#${hit.opName}`;
    const effectful = hit.port.native && hit.op.pure !== true;
    if (this.role === 'domain' && effectful) {
      this.refuse(
        'L002',
        `domain graph runs effectful native operation '${node.run}'`,
        at,
        'reach the effect through a domain port whose binding runs it',
      );
    }
    if (this.role === 'data' && !hit.port.native) {
      this.refuse(
        'L002',
        `data graph runs domain operation '${node.run}'`,
        at,
        'a data graph implements a domain port; it speaks native ports only',
      );
    }
    if (this.role === 'data' && effectful && !this.effects.allowed.has(key)) {
      this.refuse(
        'L003',
        `node '${node.id}' runs effectful '${key}' which the feature does not allow`,
        at,
        `add "${key}" to ${this.effects.at}`,
      );
    }
    if (this.role === 'domain') this.checkNoAttempts(node);
    if (hit.op.holds) {
      const hint = 'name it in project.json → startup, where what a tree starts is declared';
      this.refuse(
        'L008',
        `node '${node.id}' runs '${node.run}', which starts something that outlives the run`,
        at,
        hint,
      );
    }
  }

  /** G021 to G024, once every node is judged: what a data graph's switches catch. */
  private checkCatches(reads: GraphReads): void {
    const { refuse, nodes, routedBy, ops } = this;
    checkCatches({ refuse, nodes, routedBy, ops, scope: this.judge.scope, dependencies: reads.narrowing.dependencies });
  }

  /** L013: what an effect breaking means is the data layer's, where the effect runs; a domain graph catches nothing. */
  private refuseCatch(node: SwitchNode): void {
    const hint =
      "the domain says what is done; what an effect breaking means is the data layer's: catch it in the data graph that runs the effect";
    this.refuse('L013', `domain graph's switch '${node.id}' declares catch`, `nodes/${node.id}/catch`, hint);
  }

  /** L012: a domain graph says what is done, never how long a call may take or how often it is tried. */
  private checkNoAttempts(node: RunNode | MapNode): void {
    const hint =
      'the domain says what is done, the data layer how: write retry in the binding that meets the operation, or in the data graph that runs the effect';
    for (const word of ['retry', 'timeoutMs'] as const) {
      if (node[word] === undefined) continue;
      const message = `domain graph declares ${word} on '${node.run}'`;
      this.refuse('L012', message, `nodes/${node.id}/${word}`, hint);
    }
  }

  // ---- each node ----------------------------------------------------------------------------------

  private checkNode(node: Node, reads: GraphReads): void {
    const read = reads.readFor(node.id);
    if (isSwitch(node)) {
      checkSwitch(this, node, read);
      return;
    }
    const hit = this.ops.get(node.id);
    if (!hit) return;
    checkReason(this, node, hit, this.judge.scope);
    const extra = isMap(node) ? elementInputs(this, node, read) : {};
    const subst = checkInputs(this.judge, {
      given: node.in ?? {},
      accepts: hit.op.accepts,
      read,
      file: this.file,
      at: `nodes/${node.id}/in`,
      what: `'${node.run}'`,
      from: this.graph,
      layer: this.layer,
      extra,
      said: hit.op.refuses ? path => reads.rootOf(path) : undefined,
    });
    if (this.role === 'data' && node.retry) {
      const site = {
        file: this.file,
        at: `nodes/${node.id}`,
        retry: node.retry,
        answers: answersOf(this.judge, hit, subst),
      };
      checkCallRetry(this.judge, site, { hit, given: node.in });
    }
    reads.nodeOut(node.id);
  }
}
