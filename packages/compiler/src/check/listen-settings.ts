/**
 * The parts of the address an operation that `listens` binds, and L017: the setting a part is read from is one the
 * plugin granting the port declares, of the type the part takes (RFC 0024). `checkListens` in `contracts.ts` walks
 * the parts and judges each one's `input` there (L015) and its `setting` here, reading both with the same words.
 * L018 is here too: a port the tree writes in either place is one a socket can bind.
 */
import { type Loaded, type ObjField, type Operation, type PortDoc, show, type Type } from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/** The parts of the address `listens` names, each with the type it takes. */
export const PARTS = [
  ['port', 'number'],
  ['host', 'string'],
] as const;

/** One part of an operation's address, as its refusals name it: the operation, the part and the type it takes. */
export interface Part {
  refuse: Refuser;
  name: string;
  part: 'port' | 'host';
  kind: 'number' | 'string';
}

/**
 * L017: the setting a part is read from is one the plugin granting the port declares, of the part's type, since the
 * project writes it under that plugin's `settings`. A port no plugin grants has no plugin settings to read.
 */
export function checkListenSetting(judge: Judge, port: Loaded<PortDoc>, where: Part, setting: string): void {
  const { refuse, name, part, kind } = where;
  const settings = settingsOf(judge, port);
  const found = misfit(settings, setting, kind);
  if (found === undefined) return;
  const at = `operations/${name}/listens/${part}/setting`;
  const plugin = port.native;
  if (!plugin) {
    const message = `operation '${name}' reads its ${part} from settings.${setting}, but no plugin grants this port`;
    refuse('L017', message, at, `drop "setting": only a port a plugin grants reads that plugin's settings`);
    return;
  }
  refuse(
    'L017',
    `operation '${name}' reads its ${part} from ${plugin} settings.${setting}, which ${found || `${plugin} does not declare`}`,
    at,
    `name a ${kind} setting ${plugin} declares: ${listed(settings, kind, 'declare one in plugin.json, or drop "setting"')}`,
  );
}

/** The settings the plugin granting a port declares, by name; none for a port no plugin grants. */
function settingsOf(judge: Judge, port: Loaded<PortDoc>): Record<string, ObjField> {
  const manifest = port.native ? judge.scope.registry.get('plugin', `${port.native}/plugin.json`) : undefined;
  return fieldsOf(judge.quiet(manifest?.doc.settings));
}

/** The fields of an object type, by name; none for any other type, or for none at all. */
export const fieldsOf = (type: Type | undefined): Record<string, ObjField> =>
  type?.kind === 'object' ? type.fields : {};

/** How the field a part names misses the part's type: `''` where there is no such field, nothing where it fits. */
export function misfit(fields: Record<string, ObjField>, key: string, kind: Part['kind']): string | undefined {
  const field = fields[key];
  if (field?.type.kind === kind) return undefined;
  return field ? `is ${show(field.type)}, not ${kind}` : '';
}

/** The names of the fields of one type, for a hint to list; `none -- ` and what to do where there is none. */
export function listed(fields: Record<string, ObjField>, kind: Part['kind'], none: string): string {
  const names = Object.keys(fields).filter(key => fields[key].type.kind === kind);
  return names.length ? names.join(', ') : `none -- ${none}`;
}

/** The highest port a socket binds; 0 asks the system for any free one. */
const HIGHEST_PORT = 65535;

/** One port the tree writes where an operation's `listens` reads it: where, said and as an `at`, and the value. */
interface Written {
  said: string;
  at: string;
  value: unknown;
}

/**
 * L018: a port the tree writes where an operation's `listens` reads it -- a startup step's input, or the setting of
 * the plugin granting the port -- is a whole number from 0 to 65535, since no socket binds another and `listen`
 * throws on it at start. Only a literal number is judged: a port read from a secret is not known until the tree
 * starts, and a value of another type is B007's or C002's. A place L015 or L017 refuses is not read.
 */
export function checkListenPorts(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): void {
  const refuse = judge.refuser(judge.project.path);
  for (const { said, at, value } of portsWritten(judge, port, name, op)) {
    if (typeof value !== 'number' || bindable(value)) continue;
    refuse(
      'L018',
      `${said} is ${value}, a port no socket can bind: '${name}' listens on a whole number from 0 to ${HIGHEST_PORT}`,
      at,
      `write a whole number from 0 to ${HIGHEST_PORT} there (0 asks the system for any free port)`,
    );
  }
}

/** Is a number a port a socket can bind? */
const bindable = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= HIGHEST_PORT;

/** Every port the tree writes where an operation's `listens.port` reads it: each step's input, then the setting. */
function portsWritten(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): Written[] {
  const { input, setting } = op.listens?.port ?? {};
  const written: Written[] = [];
  if (input !== undefined && misfit(fieldsOf(judge.acceptsType(op)), input, 'number') === undefined)
    written.push(...stepsWriting(judge, port, name, input));
  if (setting !== undefined && misfit(settingsOf(judge, port), setting, 'number') === undefined)
    written.push(...settingWritten(judge, port, setting));
  return written;
}

/** The input each startup step that runs the operation writes for its port, where one writes it. */
function stepsWriting(judge: Judge, port: Loaded<PortDoc>, name: string, input: string): Written[] {
  return (judge.project.doc.startup ?? []).flatMap((step, index) => {
    const hit = judge.scope.op(step.run);
    if (typeof hit === 'string' || hit.port.path !== port.path || hit.opName !== name) return [];
    if (!step.in || !(input in step.in)) return [];
    return [{ said: `startup step ${index}'s in.${input}`, at: `startup/${index}/in/${input}`, value: step.in[input] }];
  });
}

/** The setting the project writes under the plugin granting the port, where it writes it. */
function settingWritten(judge: Judge, port: Loaded<PortDoc>, setting: string): Written[] {
  return judge.project.doc.plugins.flatMap((use, index) => {
    const settings = use.settings ?? {};
    if (use.use !== port.native || !(setting in settings)) return [];
    const at = `plugins/${index}/settings/${setting}`;
    return [{ said: `${use.use} settings.${setting}`, at, value: settings[setting] }];
  });
}
