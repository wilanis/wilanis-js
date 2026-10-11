/**
 * A literal `[]` where a list of a shape is taken (#903). It types as the empty list, which feeds a list of any
 * type, so a node's `in` takes it without G004 and a connection's settings without C002; a typed constant is no
 * longer the only way to write it. A list with items is still judged item by item.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageSaying } from './example-harness.js';

const NONE = 'features/customers/data/list-raw-none.graph.json';
const EMPLOYEES = 'connections/employees.connection.json';

describe('a literal empty list', () => {
  it("feeds a node's input that takes a list of a shape, in place of a typed constant", () => {
    expect(
      sabotage(NONE, doc => {
        doc.nodes[0].in.list = [];
        delete doc.constants;
      }),
    ).toEqual([]);
  });
  it("feeds a connection's setting that takes a list of a shape, and a list field inside one", () => {
    expect(sabotage(EMPLOYEES, doc => (doc.settings.users = []))).toEqual([]);
    expect(sabotage(EMPLOYEES, doc => (doc.settings.users[0].groups = []))).toEqual([]);
  });
  it('leaves a list with items judged by its items', () => {
    expect(sabotageSaying(NONE, doc => (doc.nodes[0].in.list = [{ id: 1 }]))[0]).toMatch(/^G004 /);
    expect(sabotageSaying(EMPLOYEES, doc => (doc.settings.users = [{ username: 1 }]))[0]).toMatch(/^C002 /);
  });
});
