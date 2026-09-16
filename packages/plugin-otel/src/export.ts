/**
 * exporter.port.json#export: what sends this tree's runs to a collector. A project's startup list names it,
 * as it names the listener and the watcher; nothing exports on its own, so a tree that names no step sends
 * nothing and a reader of project.json can see that at the root.
 *
 * It subscribes through `serving.observe`, which lives on the server rather than on the tree: a reload builds
 * a fresh embedder underneath, and this holds the server, so the export survives it exactly as an open socket
 * does.
 */
import type { Hold, Serving, Trace } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import { Exporter, type Sends } from './exporter.js';
import { at } from './level.js';
import { EXPORT } from './paths.js';
import { type Configured, configure, type OtelEnv } from './settings.js';

/** What a tree hands this held operation: the server to observe, and the way to hand back its teardown. */
type ExportEnv = OtelEnv & { serving?: Serving; hold?: Hold };

/**
 * How spans reach the collector. The OTLP/HTTP exporter owns the wire: the OTLP protocol, the retries and
 * the headers a collector authenticates with. What it is given is built here, because a `Trace` is a run that
 * has already happened and a tracer is for instrumenting one as it runs.
 */
async function sender(configured: Configured): Promise<Sends> {
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const exporter = new OTLPTraceExporter({
    url: configured.endpoint,
    ...(Object.keys(configured.headers).length ? { headers: configured.headers } : {}),
  });
  return exporter as unknown as Sends;
}

/** What the step answers, so a startup report says where this tree's runs go and under what name. */
const answer = (configured: Configured) => ({ endpoint: configured.endpoint, service: configured.service });

/**
 * Send every run of this tree to the collector until the process stops. Answers once it is subscribed; the
 * sending outlives the run, so the runtime holds it and stops it -- flushing what is waiting -- before the
 * plugins' teardowns, so a process that ends takes its last traces with it.
 */
export const exportTraces: Handler = async ({ in: input, ctx }) => {
  const env = ctx.env as ExportEnv;
  const serving = env.serving;
  if (!serving || !env.hold)
    throw new Error(
      `'${EXPORT}' exports the runs of a tree while it is served, so it runs from a project's startup list -- not from a graph`,
    );
  const configured = configure(env, input);
  const exporter = new Exporter({ sends: await sender(configured), configured, log: serving.log });
  const listening = serving.observe((trace: Trace) => exporter.take(at(trace, configured.level)));
  serving.log(`otel: exporting runs to ${configured.endpoint} as '${configured.service}' (${configured.level})`);
  env.hold({
    label: `otel → ${configured.endpoint}`,
    stop: async () => {
      listening();
      await exporter.stop();
    },
  });
  return answer(configured);
};
