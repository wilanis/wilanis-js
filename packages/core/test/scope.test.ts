import { describe, expect, it } from 'vitest';
import { joinPath, READ_PATH, splitPath, TEMPLATE, WHOLE_TEMPLATE } from '../src/templates.js';

describe('read paths', () => {
  it('splits identifiers and quoted keys into segments', () => {
    expect(splitPath('in')).toEqual(['in']);
    expect(splitPath('asked.body.id')).toEqual(['asked', 'body', 'id']);
    expect(splitPath("context.headers['user-agent']")).toEqual(['context', 'headers', 'user-agent']);
    expect(splitPath('context.headers["x-request-id"].0')).toEqual(['context', 'headers', 'x-request-id', '0']);
  });
  it('writes segments back, quoting what is not an identifier', () => {
    expect(joinPath(['context', 'headers', 'user-agent'])).toBe("context.headers['user-agent']");
    expect(joinPath(['asked', 'body', 'id'])).toBe('asked.body.id');
  });
  it('a template may carry a quoted key; a bare hyphen is not a path', () => {
    expect(WHOLE_TEMPLATE.exec("{{context.headers['user-agent']}}")?.[1]).toBe("context.headers['user-agent']");
    expect(WHOLE_TEMPLATE.test('{{context.headers.user-agent}}')).toBe(false);
    expect([...'a {{x.y}} b {{z["k k"]}}'.matchAll(TEMPLATE)].map(match => match[1])).toEqual(['x.y', 'z["k k"]']);
    expect(READ_PATH.test("context.headers['user-agent']")).toBe(true);
    expect(READ_PATH.test('context.')).toBe(false);
  });
});
