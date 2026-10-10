/**
 * RFC 0032's worked example: a plugin whose one port asks for its site. `record` keeps the text it is given and the
 * site the compiler handed it, and -- to show what two strings open -- the label of the node or binding operation the
 * site points at, read through `env.document`. `watch` is the `holds` operation a startup step names, keeping its
 * site the same way. Nothing it read was carried in the spec: it went and got it.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';

/** One note as the fixture keeps it: what was given, where from, and what the document says at that position. */
export interface Note {
  text?: string;
  site: { file: string; at: string };
  label?: string;
}

/** Every note recorded since `forget`, in order. */
export const notes: Note[] = [];

/** Forget every note, so a test starts from nothing. */
export const forget = () => notes.splice(0, notes.length);

/** The label at a position of a document: a node by its id under `nodes/<id>`, an operation under `operations/<name>`. */
function labelAt(doc: unknown, at: string): string | undefined {
  const [head, name] = at.split('/');
  const document = doc as {
    nodes?: { id: string; label?: string }[];
    operations?: Record<string, { description?: string }>;
  };
  if (head === 'nodes') return document.nodes?.find(node => node.id === name)?.label;
  if (head === 'operations') return document.operations?.[name]?.description;
  return undefined;
}

/** Keep what was handed, and what the site opens. */
const record: Handler = async ({ in: input, ctx }) => {
  const site = input.site as Note['site'];
  const document = ctx.env.document as (path: string) => unknown;
  notes.push({ text: input.text as string, site, label: labelAt(document(site.file), site.at) });
  return true;
};

/** Keep the step this was named from; hold nothing. */
const watch: Handler = async ({ in: input, ctx }) => {
  notes.push({ site: input.site as Note['site'] });
  const hold = ctx.env.hold as ((what: { label: string; stop: () => Promise<void> }) => void) | undefined;
  hold?.({ label: 'note watch', stop: async () => undefined });
  return true;
};

const note: PluginModule = {
  root: '@note',
  docs: fileURLToPath(new URL('./docs', import.meta.url)),
  handlers: { '@note/note.port.json#record': record, '@note/note.port.json#watch': watch },
};

export default note;
