/**
 * What the viewer says a trigger reaches follows the profiles that serve it, as the checker's judgement of the
 * trigger does (#632): the refusals a trigger's page says it answers (T005 and T006 judge the same table) and the
 * views its *Gated by* list marks (A008's walk) are walked under the profiles that walk the trigger, so a page
 * never names a node only a profile that never opens the route would reach. On the example as it ships a profile
 * that listens binds as one that does not, so nothing would move; each case takes a profile with a binding of its
 * own out of the listener instead: `live`, the one that meets the customers over REST, or `local`, the one that
 * keeps them in memory.
 */
import { describe, expect, it } from 'vitest';
import { type Edits, scopedView } from './scoped-harness.js';

const LISTEN = '@http/server.port.json#listen';
/** The example with one profile left out of the listener: its routes are served under the other two alone. */
const quiet = (profile: string): Edits => ({
  'project.json': (project: any) => {
    const listen = project.startup.find((step: any) => step.run === LISTEN);
    listen.profiles = listen.profiles.filter((one: string) => one !== profile);
  },
});
const GET_ROW = '@features/customers/data/get-row.graph.json';
const EMPLOYEES_ONLY = '@features/access/edge/employees-only.policy.json';

describe("the viewer's trigger page, under the profiles that serve the trigger", () => {
  it('names no refusing node only a profile that never opens the route reaches', () => {
    // only live meets the customers over REST, so once it opens no route the get route never runs get-row:
    // `missing` is refused by the stores' graphs alone, and `upstream`, which only get-row refuses with, is
    // shown as the mapping it is with nothing reaching it -- T006's own case
    const answers = scopedView('@features/customers/edge/get-customer.trigger.json', quiet('live')).answers ?? [];
    const from = (reason: string) => answers.find(one => one.reason === reason)?.from.map(one => one.graph);
    expect(from('missing')).toEqual([
      '@features/customers/data/kept-get.graph.json',
      '@features/customers/data/kept-get-postgres.graph.json',
    ]);
    expect(from('upstream')).toEqual([]);
    expect(from('missing')).not.toContain(GET_ROW);
  });

  it('marks on Gated by no view only a profile that never opens the route reads', () => {
    // local's get reads every tenant's customers through the view, and the update route reaches that get: while
    // local listens the registrar route's employees-only attachment is the one A008 holds it to, and once it
    // does not, no profile that serves the route reads the view, so nothing is marked
    const viewing: Edits = {
      'features/customers/data/kept-get.graph.json': (doc: any) => {
        doc.nodes[0].in.collection = 'everyCustomer';
      },
    };
    const policy = (edits: Edits) =>
      scopedView('@features/customers/edge/update-customer.trigger.json', edits).policies?.find(
        one => one.path === EMPLOYEES_ONLY,
      );
    expect(policy(viewing)?.required).toEqual([
      {
        store: '@features/customers/data/customers.store.json',
        storeLabel: 'Customers',
        view: 'everyCustomer',
        of: 'customers',
      },
    ]);
    expect(policy({ ...viewing, ...quiet('local') })?.required).toBeUndefined();
  });
});
