/**
 * L018: a port the tree writes where an operation's `listens` reads it is one a socket can bind. The example's
 * `Listen` step runs `@http/server.port.json#listen`, whose port is the step's `in.port`, else `@http`'s
 * `settings.port`, else 8080; each case writes one of those two in a copy of the example's project.json.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

const PROJECT = 'project.json';
const LISTEN = '@http/server.port.json#listen';

/** The index of the example's step that listens, and of its `@http` plugin, as project.json writes them. */
const stepOf = (doc: any): number => doc.startup.findIndex((step: any) => step.run === LISTEN);
const httpOf = (doc: any): number => doc.plugins.findIndex((use: any) => use.use === '@http');

/** The example with the Listen step writing `port` under `in`. */
const onStep = (port: unknown) => (doc: any) => {
  const step = doc.startup[stepOf(doc)];
  step.in = { ...step.in, port };
};

/** The example with `@http` settings writing `port`. */
const inSettings = (port: unknown) => (doc: any) => {
  doc.plugins[httpOf(doc)].settings.port = port;
};

/** The example with `port` read from a secret the project declares, written by `write`. */
const secretPort = (write: (port: unknown) => (doc: any) => void) => (doc: any) => {
  doc.secrets = { ...doc.secrets, port: 'CUSTOMERS_PORT' };
  write('{{secrets.port}}')(doc);
};

describe('sabotage: a listen port no socket can bind (L018)', () => {
  it('L018 a step input of 70000, -1 or 1.5, where the step writes it', () => {
    for (const port of [70000, -1, 1.5]) {
      const pointed = sabotagePointing(PROJECT, onStep(port));
      expect(pointed).toEqual([expect.stringMatching(/^L018 @project\.json#startup\/\d+\/in\/port$/)]);
    }
    expect(sabotageSaying(PROJECT, onStep(70000))).toEqual([
      expect.stringMatching(
        /^L018 startup step \d+'s in\.port is 70000, a port no socket can bind: 'listen' listens on a whole number from 0 to 65535$/,
      ),
    ]);
  });

  it('L018 an @http settings.port of 70000, -1 or 1.5, where the project writes it', () => {
    for (const port of [70000, -1, 1.5]) {
      expect(sabotagePointing(PROJECT, inSettings(port))).toEqual([
        expect.stringMatching(/^L018 @project\.json#plugins\/\d+\/settings\/port$/),
      ]);
    }
    expect(sabotageSaying(PROJECT, inSettings(-1))).toEqual([
      "L018 @http settings.port is -1, a port no socket can bind: 'listen' listens on a whole number from 0 to 65535",
    ]);
    expect(sabotageHinting(PROJECT, inSettings(1.5))).toEqual([
      'L018 write a whole number from 0 to 65535 there (0 asks the system for any free port)',
    ]);
  });

  it('L018 each place on its own, where both are written wrong', () => {
    const both = (doc: any) => {
      onStep(70000)(doc);
      inSettings(65536)(doc);
    };
    expect(sabotage(PROJECT, both)).toEqual(['L018', 'L018']);
  });

  it('none for 0, 8080 or 65535, in either place', () => {
    for (const port of [0, 8080, 65535]) {
      expect(sabotage(PROJECT, onStep(port))).toEqual([]);
      expect(sabotage(PROJECT, inSettings(port))).toEqual([]);
    }
  });

  it('no L018 for a port read from a secret, which is not known until the tree starts', () => {
    // a secret reads as a string, so where a number is taken the types refuse it: B007 on the step, C002 in settings
    expect(sabotage(PROJECT, secretPort(onStep))).toEqual(['B007']);
    expect(sabotage(PROJECT, secretPort(inSettings))).toEqual(['C002']);
  });
});
