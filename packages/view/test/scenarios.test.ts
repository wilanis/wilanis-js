/**
 * What the viewer shows of scenarios (RFC 0018, step 8): a scenario's page links the trigger it replays and the
 * policy whose decision it fires, draws the branch it proves as a chain opening the graph, says the refusal it
 * expects or why no input reaches its branch, and marks one a command wrote; a trigger's page lists the scenarios
 * replaying it, grouped by who wrote them as `wilanis ls` marks them. The example keeps no scenario, so a copy of it
 * is planted with one of each kind. The page's functions are lifted from its source and run over a stand-in for the
 * DOM, since the page is one static file.
 */
import { readFile } from 'node:fs/promises';
import { schemaUrl } from '@wilanis/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DocView } from '../src/index.js';
import { type Drawn, drawn, lifted, PAGE, words } from './page-harness.js';
import { plantedViews, scopedView } from './scoped-harness.js';

const GET_CUSTOMER = '@features/customers/edge/get-customer.trigger.json';
const DELETE_CUSTOMER = '@features/customers/edge/delete-customer.trigger.json';
const GET_ROW = '@features/customers/data/get-row.graph.json';
const EMPLOYEES_ONLY = '@features/access/edge/employees-only.policy.json';
const MISSING = '@scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json';
const EMPTY_ID = '@scenarios/edges/customers.get-customer/id.empty.scenario.json';
const KEPT = '@scenarios/first-miss.scenario.json';
const ANONYMOUS =
  '@scenarios/rehearsed/policies/access.employees-only/access.require-employee.isEmployee.anonymous.scenario.json';
const UNREACHABLE = '@scenarios/rehearsed/customers.list-customers/customers.list-rows.outcome.customers.scenario.json';

const routed = (id: string, to: string) => ({ [id]: { status: 'done', selected: to, out: to } });

/** A scenario document as the recorder or a person writes one, over these fields. */
const scenario = (fields: Record<string, unknown>) => ({
  $schema: schemaUrl('scenario'),
  description: 'A run of the example, planted for the page.',
  trigger: GET_CUSTOMER,
  seed: 1,
  in: { id: 'c1' },
  ...fields,
});

const MISSING_RUN = {
  branch: { graph: GET_ROW, node: 'outcome', when: 'status == 404', to: 'noCustomer' },
  expect: { status: 'failed', reason: 'missing', nodes: routed('op.outcome', 'noCustomer') },
};

/** One scenario of each kind, by its path below the copy's root. */
const PLANTED = {
  [MISSING.slice(1)]: scenario({ generated: 'rehearse', ...MISSING_RUN }),
  [EMPTY_ID.slice(1)]: scenario({
    generated: 'edges',
    in: { id: '' },
    expect: { status: 'failed', reason: 'upstream', nodes: routed('op.outcome', 'upstreamFailed') },
  }),
  [KEPT.slice(1)]: scenario(MISSING_RUN),
  [ANONYMOUS.slice(1)]: scenario({
    generated: 'rehearse',
    trigger: DELETE_CUSTOMER,
    policy: EMPLOYEES_ONLY,
    branch: {
      graph: '@features/access/domain/require-employee.graph.json',
      node: 'isEmployee',
      when: 'else',
      to: 'anonymous',
    },
    expect: { status: 'failed', reason: 'anonymous', nodes: routed('op.isEmployee', 'anonymous') },
  }),
  [UNREACHABLE.slice(1)]: {
    ...scenario({ generated: 'rehearse', trigger: '@features/customers/edge/list-customers.trigger.json' }),
    in: undefined,
    branch: {
      graph: '@features/customers/data/list-rows.graph.json',
      node: 'outcome',
      when: 'status == 200 && has(body)',
      to: 'customers',
    },
    expect: { status: 'unreachable', nodes: {}, unreachable: 'the rules before it already cover every input' },
  },
};

let views: Record<string, DocView>;

beforeAll(() => {
  const paths = [GET_CUSTOMER, DELETE_CUSTOMER, MISSING, KEPT, ANONYMOUS, UNREACHABLE];
  const seen = plantedViews(PLANTED, paths);
  views = Object.fromEntries(paths.map((path, at) => [path, seen[at]]));
}, 60_000);

/** The steps of a chain: each one's heading, and what it says. */
const stepsOf = (chain: Drawn) =>
  chain.children.filter(one => one.cls === 'step').map(one => [one.children[0].text, words(one.children[1])]);

describe('the view model: scenarios', () => {
  it("groups a trigger's scenarios as ls marks them, each saying what it proves and how it expects to end", () => {
    expect(views[GET_CUSTOMER].scenarios).toEqual([
      {
        by: 'rehearse',
        writtenBy: 'wilanis rehearse --record',
        scenarios: [
          { path: MISSING, said: "get-row 'outcome' when status == 404 → noCustomer", expects: 'failed as missing' },
        ],
      },
      {
        by: 'edges',
        writtenBy: 'wilanis fuzz --edges',
        scenarios: [{ path: EMPTY_ID, said: 'id.empty', expects: 'failed as upstream' }],
      },
      {
        by: 'hand',
        scenarios: [
          { path: KEPT, said: "get-row 'outcome' when status == 404 → noCustomer", expects: 'failed as missing' },
        ],
      },
    ]);
  });

  it("leaves a policy's decision to the policy, and carries no group on a trigger no scenario replays", () => {
    expect(views[DELETE_CUSTOMER].scenarios).toEqual([]);
    expect(scopedView(GET_CUSTOMER).scenarios).toEqual([]);
  });

  it('marks a scenario a command wrote with the sentence describe prints, and one kept by hand with none', () => {
    expect(views[MISSING].generated).toBe('generated by wilanis rehearse --record: regenerate, do not edit');
    expect(views[KEPT].generated).toBeUndefined();
  });
});

describe('the scenario page', () => {
  const drawnPage = async (view: DocView) => {
    const { scenarioEl } = await lifted('scenarioChainEl', 'branchEl', 'scenarioEl');
    const page = drawn({ tag: 'main' });
    scenarioEl(page, view);
    return page;
  };

  it('links the trigger it replays, says the refusal it expects, and draws the branch opening the graph', async () => {
    const page = await drawnPage(views[MISSING]);
    const [mark, chain, , branch] = page.children;
    expect(words(mark)).toBe('rehearse Generated by wilanis rehearse --record: regenerate, do not edit.');
    expect(stepsOf(chain)).toEqual([
      ['replays', GET_CUSTOMER],
      ['expects', 'failed, refusing as missing'],
    ]);
    expect(chain.children[0].children[1]).toMatchObject({ tag: 'a', path: GET_CUSTOMER });
    expect(stepsOf(branch)).toEqual([
      ['in the graph', GET_ROW],
      ['the switch', 'outcome'],
      ['when', 'status == 404'],
      ['routes to', 'noCustomer'],
    ]);
    const links = branch.children.filter(one => one.cls === 'step').map(one => one.children[1]);
    expect(links[0]).toMatchObject({ path: GET_ROW });
    expect(links[1]).toMatchObject({ path: GET_ROW, node: 'outcome' });
    expect(links[3]).toMatchObject({ path: GET_ROW, node: 'noCustomer' });
    expect(page.children.map(words)).toContain('Expected per node');
  });

  it("links the policy whose decision it fires in the trigger's place, and says the else as otherwise", async () => {
    const [, chain, , branch] = (await drawnPage(views[ANONYMOUS])).children;
    expect(stepsOf(chain)).toEqual([
      ['through the trigger', DELETE_CUSTOMER],
      ['the decision of', EMPLOYEES_ONLY],
      ['expects', 'failed, refusing as anonymous'],
    ]);
    expect(stepsOf(branch)[2]).toEqual(['otherwise', 'no rule holds']);
  });

  it('says why no input reaches an unreachable branch, and tables no node, since nothing ran', async () => {
    const said = (await drawnPage(views[UNREACHABLE])).children.map(words);
    expect(said).toContain('No input reaches this branch: the rules before it already cover every input');
    expect(said).not.toContain('Expected per node');
    expect(said).not.toContain('Input');
  });

  it('marks nothing on a scenario kept by hand', async () => {
    const [first] = (await drawnPage(views[KEPT])).children;
    expect(first.cls).toBe('chain');
  });

  it('draws the scenario case through scenarioEl, which reads no d.graph', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/case 'scenario': \{\n\s*scenarioEl\(page, v\);\n\s*break;/);
    const drawing = page.match(/function scenarioChainEl\(d\) \{[\s\S]*?\n {2}function renderDocPage/)?.[0] ?? '';
    expect(drawing).not.toContain('d.graph');
  });
});

describe("the trigger page's scenarios", () => {
  it('lists them grouped by who wrote them, each opening its page', async () => {
    const { triggerScenariosEl } = await lifted('triggerScenariosEl');
    const page = drawn({ tag: 'main' });
    triggerScenariosEl(page, views[GET_CUSTOMER].scenarios);
    expect(page.children.map(words)).toEqual([
      'Scenarios (3)',
      'Written by wilanis rehearse --record (rehearse)',
      "get-row 'outcome' when status == 404 → noCustomer  expects failed as missing",
      'Written by wilanis fuzz --edges (edges)',
      'id.empty  expects failed as upstream',
      'Written by hand',
      "get-row 'outcome' when status == 404 → noCustomer  expects failed as missing",
    ]);
    expect(page.children[2].children[0]).toMatchObject({ tag: 'a', path: MISSING });
  });

  it('says how to write them where none replays it, and is drawn at the end of the trigger page', async () => {
    const { triggerScenariosEl } = await lifted('triggerScenariosEl');
    const page = drawn({ tag: 'main' });
    triggerScenariosEl(page, []);
    expect(page.children.map(words)).toEqual([
      'Scenarios (0)',
      'No scenario replays this trigger yet: wilanis rehearse --record writes one per branch, wilanis fuzz --edges one per input edge.',
    ]);
    const source = await readFile(PAGE, 'utf8');
    expect(source).toMatch(/if \(v\.scenarios\) triggerScenariosEl\(page, v\.scenarios\);\n\s*break;/);
  });
});
