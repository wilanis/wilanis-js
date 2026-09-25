/**
 * The runtime package's version, read once from its package.json: what `--json`'s envelope and the manifest print
 * as `runtime`, and the version of every plugin the runtime ships (@std, @cli). `createRequire` rather than a JSON
 * import: package.json sits outside `rootDir`, and `../package.json` is the package root both from `src/` under a
 * test and from `dist/` in the published package, which always ships its package.json.
 */
import { createRequire } from 'node:module';

/** The version of @wilanis/runtime this process runs. */
export const RUNTIME_VERSION: string = createRequire(import.meta.url)('../package.json').version;
