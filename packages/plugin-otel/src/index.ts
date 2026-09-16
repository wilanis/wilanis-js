/**
 * @wilanis/plugin-otel, the @otel plugin: this tree's runs, shipped to an OpenTelemetry collector as spans.
 *
 * Nothing is instrumented by an author and nothing is added to a tree to be traced: every fire already leaves
 * a report, the runtime says it as a `Trace`, and this sends it. What makes it happen is the `holds` operation
 * a project's startup list names -- a tree that names no step exports nothing, as a tree that names no
 * listener serves nothing -- so whether traces leave the process is written where a reader of project.json
 * will see it.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import { exportTraces } from './export.js';
import { EXPORT, ROOT } from './paths.js';
import { check } from './rules.js';

export type { ExporterOptions, Sends } from './exporter.js';
export { Exporter } from './exporter.js';
export { at } from './level.js';
export type { Level } from './paths.js';
export { EXPORT, isLevel, PORT, ROOT } from './paths.js';
export type { Configured } from './settings.js';
export { configure } from './settings.js';
export type { Parent, Scope, Span } from './spans.js';
export { parentOf, spansOf } from './spans.js';

const DOCS = fileURLToPath(new URL('../docs', import.meta.url));

const otel: PluginModule = {
  root: ROOT,
  docs: DOCS,
  handlers: { [EXPORT]: exportTraces },
  check,
};

export default otel;
