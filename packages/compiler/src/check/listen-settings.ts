/**
 * The parts of the address an operation that `listens` binds, and L017: the setting a part is read from is one the
 * plugin granting the port declares, of the type the part takes (RFC 0024). `checkListens` in `contracts.ts` walks
 * the parts and judges each one's `input` there (L015) and its `setting` here, reading both with the same words.
 */
import { type Loaded, type ObjField, type PortDoc, show, type Type } from '@wilanis/core';
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
