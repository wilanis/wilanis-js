/**
 * Typing what a graph's nodes read: the input, a constant, a resolver, or another node's answer. A node's
 * output type comes from its operation, with the variables its type fields bind substituted; a read the
 * routing switch proved present loses its optionality. Every read is remembered, for G008, and who read whom
 * is what G015 judges an effect by: one no switch routes runs on every branch, so its answer is read on all
 * of them or the effect was misplaced.
 */
import {
  EMPTY_OBJECT,
  hasVars,
  isMap,
  isSwitch,
  type Node,
  type OpHit,
  type Read,
  STRING,
  substitute,
  type Type,
  typeAt,
  WHOLE_TEMPLATE,
} from '@wilanis/core';
import { bindings } from '../documents.js';
import { firstReaders, type Routing, readersOf, readOnSomeBranchesOnly, routed } from './graph-routing.js';
import type { RootOf } from './inputs.js';
import type { Judge, JudgedResolver, Reader, Refuser } from './judge.js';
import { Narrowing } from './narrowing.js';
import { readAt } from './typing.js';

/** The graph as tabled: its nodes, the operations they run, and the roots its values may read. */
export interface GraphTable {
  file: string;
  nodes: Map<string, Node>;
  ops: Map<string, OpHit>;
  resolvers: Record<string, JudgedResolver>;
  inType: Type | undefined;
  constTypes: Record<string, Type>;
}

/**
 * G003's hint. A root that named nothing in scope is most often a read of the request the graph never bound,
 * so the hint writes the `reads` entry that would bind it; where the reason was something else, it says the
 * four roots a value may read.
 */
function hintForRoot(root: string | undefined): string {
  if (!root) return 'read in, const, or a node that runs before this one';
  return `to read the request, bind the name: "reads": { "${root}": "@<feature>/edge/<file>.resolvers.json#${root}" }`;
}

/**
 * What a graph's values may read, typed: in, a constant, a resolver, or another node's answer (G003), with a
 * path the routing switch proved present losing its optionality. It remembers every read, for G008 to judge
 * what is declared and never read, and for P005 to judge the same of the `reads` map.
 */
export class GraphReads {
  readonly readsIn = new Set<string>();
  readonly readsConst = new Set<string>();
  readonly readsResolvers = new Set<string>();
  readonly readNodes = new Set<string>();
  readonly narrowing: Narrowing;
  private readonly outTypes = new Map<string, Type | undefined>();
  private readonly computing = new Set<string>();
  private readonly refuse: Refuser;
  /** the node whose reads are being typed: what its router proved is in force */
  private reading: string | undefined;
  /** the root of the value being typed that named nothing in scope: what G003's hint offers to bind */
  private unbound: string | undefined;

  constructor(
    private readonly judge: Judge,
    readonly table: GraphTable,
  ) {
    this.refuse = judge.refuser(table.file);
    this.narrowing = new Narrowing(judge.scope, table.nodes);
  }

  /** A reader with the narrowing of node `id` in force. */
  readFor(id: string): Reader {
    return (value, at) => {
      const previous = this.reading;
      this.reading = id;
      try {
        return this.valueRead(value, at);
      } finally {
        this.reading = previous;
      }
    };
  }

  /**
   * G015: an effect whose answer only some branches read. A node runs when what it reads is ready, whatever a
   * switch chose, so an effect no switch routes runs on every branch; where every reader of its answer sits
   * behind a branch, and no switch that always runs is reached through all of its targets, the effect ran for
   * nothing on the rest -- most often a write the author meant one branch to make. An effect out.from names
   * is the graph's answer, and a pure node running for nothing costs nothing. One no value read at all is
   * G008's alone, judged by the same `readNodes`, so a node earns one refusal for one misunderstanding.
   */
  checkEffectsRouted(routedBy: Map<string, string>, candidates: string[]): void {
    const routing: Routing = { routedBy, dependencies: this.narrowing.dependencies };
    const readers = readersOf(routing.dependencies);
    for (const [id, hit] of this.table.ops) {
      if (hit.op.pure === true || !this.readNodes.has(id) || candidates.includes(id)) continue;
      if (routed(routing, id)) continue;
      const who = [...(readers.get(id) ?? [])];
      if (!readOnSomeBranchesOnly(routing, this.table.nodes, who)) continue;
      const named = firstReaders(routing, who)
        .map(reader => `'${reader}'`)
        .join(', ');
      this.refuse(
        'G015',
        `effect '${id}' runs on every branch, but its answer is read only under ${named}`,
        `nodes/${id}`,
        `route the effect under the branch that reads it: make '${id}' the 'to' of the switch rule that leads to ${named}, or read its answer from every branch`,
      );
    }
  }

  /** The type a node answers: a switch the id it chose, a call its operation's returns, a map a list of them. */
  nodeOut(id: string): Type | undefined {
    if (this.outTypes.has(id)) return this.outTypes.get(id);
    if (this.computing.has(id)) return undefined;
    this.computing.add(id);
    const type = this.computeOut(id);
    this.computing.delete(id);
    this.outTypes.set(id, type);
    return type;
  }

  private computeOut(id: string): Type | undefined {
    const node = this.table.nodes.get(id);
    if (!node) return undefined;
    if (isSwitch(node)) return STRING;
    const hit = this.table.ops.get(id);
    if (!hit) return undefined; // its operation was refused already
    let returns = this.judge.quiet(hit.op.returns) ?? EMPTY_OBJECT;
    if (hasVars(returns)) returns = substitute(returns, bindings(this.judge.scope, hit.op, node.in));
    return isMap(node) ? { kind: 'list', of: returns } : returns;
  }

  /**
   * The type a read path starts from and the segments below it: in, one constant, a resolver or a node's
   * answer. Nothing is remembered as read, since only the path's own read says what a graph uses.
   */
  rootOf(path: string[]): RootOf | undefined {
    const [root, ...below] = path;
    if (root === 'in') return this.table.inType ? { type: this.table.inType, below } : undefined;
    if (root === 'const') {
      const type = this.table.constTypes[below[0]];
      return type ? { type, below: below.slice(1) } : undefined;
    }
    if (root in this.table.resolvers) return { type: this.table.resolvers[root].read.type, below };
    const type = this.table.nodes.has(root) ? this.nodeOut(root) : undefined;
    return type ? { type, below } : undefined;
  }

  /** Type one value; a whole template the routing switch proved present loses its optionality. */
  private valueRead(value: unknown, at: string): Read | undefined {
    this.unbound = undefined;
    const read = this.judge.scope.valueRead(value, (root, path) => this.rootRead(root, path));
    if (typeof read === 'string') {
      this.refuse('G003', read, at, hintForRoot(this.unbound));
      return undefined;
    }
    if (read?.optional && this.narrowedWhole(value)) return { type: read.type, optional: false };
    return read;
  }

  private narrowedWhole(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const whole = WHOLE_TEMPLATE.exec(value);
    return whole !== null && this.narrowing.narrowed(this.reading, whole[1]);
  }

  /** Type one root a value reads; a path proved present loses its optionality wherever the node reads it. */
  private rootRead(root: string, path: string[]): Read | string | undefined {
    const read = this.rootReadRaw(root, path);
    if (typeof read !== 'object' || !read.optional) return read;
    return this.narrowing.narrowed(this.reading, [root, ...path].join('.'))
      ? { type: read.type, optional: false }
      : read;
  }

  private rootReadRaw(root: string, path: string[]): Read | string | undefined {
    if (root === 'in') return this.readIn(path);
    if (root === 'const') return this.readConst(path);
    if (root === 'request')
      return 'graphs do not read request.* -- a resolvers document does; bind it under reads and read {{name}}';
    if (root in this.table.resolvers) {
      this.readsResolvers.add(root);
      return readAt(this.table.resolvers[root].read, path);
    }
    return this.readNode(root, path);
  }

  private readIn(path: string[]): Read | string {
    if (!this.table.inType) return `reads in.${path.join('.')} but the graph declares no in`;
    this.readsIn.add(path[0] ?? '*');
    return typeAt(this.table.inType, path);
  }

  private readConst(path: string[]): Read | string {
    const name = path[0];
    const type = name ? this.table.constTypes[name] : undefined;
    if (!type)
      return `unknown constant 'const.${path.join('.')}' (constants: ${Object.keys(this.table.constTypes).join(', ') || 'none'})`;
    this.readsConst.add(name);
    return typeAt(type, path.slice(1));
  }

  private readNode(root: string, path: string[]): Read | string | undefined {
    if (!this.table.nodes.has(root)) {
      // a root that is none of the four is most often a read of the request the graph never bound (RFC 0029)
      this.unbound = root;
      return `'${root}' is not in, const, a node that runs before this one, or a name under reads`;
    }
    this.readNodes.add(root);
    const base = this.nodeOut(root);
    return base ? typeAt(base, path) : undefined; // its operation was refused already
  }
}
