/**
 * What only @queue can judge. Each case breaks the small tree one way and expects the code and the place the
 * refusal points at -- a code alone would pass for a refusal about something else entirely.
 *
 * The last block says what is deliberately *not* a rule here: a queue with no consumer in this tree, a tree
 * with queue triggers and no consume step, and what a queue trigger shares with a route, which the T family
 * judges.
 */
import { describe, expect, it } from 'vitest';
import { codes, editing, ID_REQUEST, JOBS, ONCE, PUBLISHING, refusals, TABLE, TRIGGER, tree } from './tree.js';

const edit = (file: string, change: (doc: any) => void) => refusals(editing(file, change));
const trigger = (change: (doc: any) => void) => edit(TRIGGER, change);
const publishing = (change: (doc: any) => void) => edit(PUBLISHING, change);
const project = (change: (doc: any) => void) => edit('project.json', change);
const at = (found: ReturnType<typeof refusals>, code: string) => found.filter(one => one.code === code);

describe('a tree with work to do off the request', () => {
  it('stands: a queue trigger, a graph publishing to it, and a consume step', () => {
    expect(refusals(tree())).toEqual([]);
  });
});

describe('X401: a setting a worker cannot act on', () => {
  it('an outcome that is not ack, retry or dead', () => {
    const found = at(
      trigger(doc => {
        doc.settings.outcomes.upstream = 'later';
      }),
      'X401',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/outcomes/upstream');
    expect(found[0].message).toMatch(/maps 'upstream' to "later"/);
    expect(found[0].hint).toBe('an outcome is ack, retry or dead');
  });

  it('maxAttempts of none, or of part of a delivery', () => {
    for (const maxAttempts of [0, 2.5]) {
      const found = at(
        trigger(doc => {
          doc.settings.maxAttempts = maxAttempts;
        }),
        'X401',
      );
      expect(found).toHaveLength(1);
      expect(found[0].at).toBe('settings/maxAttempts');
      expect(found[0].hint).toBe('maxAttempts is a whole number, 1 or more');
    }
  });

  it('a backoff below nothing', () => {
    const found = at(
      trigger(doc => {
        doc.settings.backoffMs = -1;
      }),
      'X401',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/backoffMs');
  });

  it("the consume step's concurrency of none", () => {
    const found = at(
      project(doc => {
        doc.startup[0].in = { concurrency: 0 };
      }),
      'X401',
    );
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('@project.json');
    expect(found[0].at).toBe('startup/0/in/concurrency');
  });

  it('a backoff of nothing and a concurrency of several are fine', () => {
    const docs = editing(TRIGGER, doc => {
      doc.settings.backoffMs = 0;
    });
    (docs['project.json'] as any).startup[0].in = { concurrency: 4 };
    expect(codes(docs)).toEqual([]);
  });
});

describe('X402: a retry on a broker that delivers at most once', () => {
  it('an outcome that retries, and onFault absent, which retries too', () => {
    const found = at(
      trigger(doc => {
        doc.settings.connection = ONCE;
      }),
      'X402',
    );
    expect(found.map(one => one.at).sort()).toEqual(['settings/onFault', 'settings/outcomes/upstream']);
    expect(found[0].message).toMatch(/which delivers at most once/);
    expect(found[0].hint).toBe(
      'a broker that delivers at most once cannot retry; map the reason to ack or dead, and set onFault',
    );
  });

  it('nothing to refuse once every outcome acks or parks and onFault says dead', () => {
    const found = trigger(doc => {
      doc.settings.connection = ONCE;
      doc.settings.outcomes.upstream = 'dead';
      doc.settings.onFault = 'dead';
    });
    expect(at(found, 'X402')).toEqual([]);
  });

  it('a profile that stands a redelivering broker in with one that does not', () => {
    const docs = tree();
    (docs['project.json'] as any).profiles = {
      lean: { bindings: {}, connections: { '@connections/jobs.connection.json': ONCE } },
    };
    const found = at(refusals(docs), 'X402');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].message).toMatch(/'@connections\/once\.connection\.json'/);
  });
});

describe('X403: a publish of what the consuming trigger does not accept', () => {
  it('a shape of another name and fields: the refusal names the trigger and the shape it consumes', () => {
    const docs = editing(PUBLISHING, doc => {
      doc.nodes[0].in.type = '@features/customers/edge/Batch.shape.json';
      doc.nodes[0].in.message = { ids: [] };
    });
    docs['features/customers/edge/Batch.shape.json'] = {
      $schema: '@wilanis/shape.schema.json',
      description: 'several customers, by id',
      layer: 'edge',
      fields: { ids: { type: 'string[]' } },
    };
    const found = at(refusals(docs), 'X403');
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('@features/customers/data/publish-removal.graph.json');
    expect(found[0].at).toBe('nodes/published/in/type');
    expect(found[0].message).toMatch(/@features\/customers\/edge\/removals\.trigger\.json consumes as/);
    expect(found[0].hint).toBe(`publish the shape the trigger consumes: ${ID_REQUEST}, or name another queue`);
  });

  it('another queue, which no trigger of this tree consumes, is not judged', () => {
    const found = publishing(doc => {
      doc.nodes[0].in.queue = 'elsewhere';
    });
    expect(at(found, 'X403')).toEqual([]);
  });
});

describe('X404: a message carrying a blob', () => {
  it("a queue trigger's message, naming where the blob sits", () => {
    const found = at(
      trigger(doc => {
        doc.settings.message = '@features/customers/edge/Upload.shape.json';
      }),
      'X404',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/message');
    expect(found[0].message).toMatch(/carries a blob at rows\.file/);
    expect(found[0].hint).toMatch(/publish the handle's id as a string/);
  });

  it("a publish's type", () => {
    const found = at(
      publishing(doc => {
        doc.nodes[0].in.queue = 'uploads';
        doc.nodes[0].in.type = '@features/customers/edge/Upload.shape.json';
        doc.nodes[0].in.message = { rows: { file: '{{in.id}}' } };
      }),
      'X404',
    );
    expect(found.map(one => one.at)).toEqual(['nodes/published/in/type']);
  });
});

describe('X405: a publish in an atomic graph to a broker outside the store', () => {
  it('a broker whose kind is not marked storage: the one refusal, at the connection', () => {
    const found = refusals(
      editing(PUBLISHING, doc => {
        doc.atomic = true;
      }),
    );
    expect(found.map(one => one.code)).toEqual(['X405']);
    expect(found[0].file).toBe('@features/customers/data/publish-removal.graph.json');
    expect(found[0].at).toBe('nodes/published/in/connection');
    expect(found[0].message).toMatch(
      /publishes to '@connections\/jobs\.connection\.json', of kind '@fake-broker\/fake\.connection-kind\.json', which is not marked storage/,
    );
    expect(found[0].hint).toBe(
      'publish after the atomic graph, in its caller, reached by a data dependency on its answer',
    );
  });

  it('a broker kept in the store joins the transaction, so nothing is refused', () => {
    const found = publishing(doc => {
      doc.atomic = true;
      doc.nodes[0].in.connection = TABLE;
    });
    expect(found).toEqual([]);
  });

  it('a profile that stands a broker outside the store in for the one inside it', () => {
    const docs = editing(PUBLISHING, doc => {
      doc.atomic = true;
      doc.nodes[0].in.connection = TABLE;
    });
    (docs['project.json'] as any).profiles = { lean: { bindings: {}, connections: { [TABLE]: JOBS } } };
    const found = at(refusals(docs), 'X405');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/of kind '@fake-broker\/fake\.connection-kind\.json' under profile 'lean'/);
  });

  it('a publish outside an atomic graph is not judged, whatever the broker', () => {
    expect(at(refusals(tree()), 'X405')).toEqual([]);
  });
});

describe('X406: two queue triggers receiving from one queue', () => {
  /** The tree with copies of the removals trigger, each at a file of its own, edited as the case says. */
  const alongside = (...copies: [string, (doc: any) => void][]) => {
    const docs = tree();
    for (const [file, change] of copies) {
      const copy = structuredClone(docs[TRIGGER]) as any;
      change(copy);
      docs[file] = copy;
    }
    return docs;
  };
  const sweep = 'features/customers/edge/sweep.trigger.json';
  const tidy = 'features/customers/edge/tidy.trigger.json';

  it('a second trigger on the same connection and queue: refused on the second, naming the first', () => {
    const found = refusals(alongside([sweep, () => {}]));
    expect(found.map(one => one.code)).toEqual(['X406']);
    expect(found[0].file).toBe('@features/customers/edge/sweep.trigger.json');
    expect(found[0].at).toBe('settings/queue');
    expect(found[0].message).toBe(
      `receives from queue 'removals' of '${JOBS}', as @features/customers/edge/removals.trigger.json already does: a message on it fires @features/customers/edge/removals.trigger.json, so this trigger never runs`,
    );
    expect(found[0].hint).toBe(
      'one trigger per queue: remove @features/customers/edge/sweep.trigger.json, or change its settings.queue to a queue no other trigger receives from',
    );
  });

  it('three on one queue: each after the first, in the order the tree lists them', () => {
    const found = at(refusals(alongside([tidy, () => {}], [sweep, () => {}])), 'X406');
    expect(found.map(one => one.file)).toEqual([
      '@features/customers/edge/sweep.trigger.json',
      '@features/customers/edge/tidy.trigger.json',
    ]);
    for (const one of found) expect(one.message).toMatch(/as @features\/customers\/edge\/removals\.trigger\.json/);
  });

  it('the same queue name on another connection, or another queue on the same one, is another queue', () => {
    const found = refusals(
      alongside([sweep, doc => (doc.settings.connection = TABLE)], [tidy, doc => (doc.settings.queue = 'sweeps')]),
    );
    expect(at(found, 'X406')).toEqual([]);
  });
});

describe('what is not a rule here', () => {
  it('a tree with queue triggers and no consume step: nothing is consumed, as no listener serves nothing', () => {
    expect(
      codes(
        editing('project.json', doc => {
          doc.startup = [];
        }),
      ),
    ).toEqual([]);
  });
});
