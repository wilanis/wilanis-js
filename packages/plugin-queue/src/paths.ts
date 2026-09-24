/** The documents this plugin ships, by the paths a tree names them at: one alias root and the files under docs/. */

export const ROOT = '@queue';
/** The path of a document this plugin ships. */
export const doc = (name: string) => `${ROOT}/${name}`;

/** What a data graph runs: publish and ensure. */
export const QUEUE_PORT = doc('queue.port.json');
/** What a startup step names: consume. */
export const WORKER_PORT = doc('worker.port.json');
export const KIND = doc('queue.trigger-kind.json');

export const PUBLISH = `${QUEUE_PORT}#publish`;
export const ENSURE = `${QUEUE_PORT}#ensure`;
/** The operation a project's startup list names to work the tree's queues. */
export const CONSUME = `${WORKER_PORT}#consume`;
