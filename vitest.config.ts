/**
 * Two test projects. `packages` is the tests beside each package, over the `dist` a build produced. `fitness`
 * is the suite under `fitness/`, which reads this repository's source as text and needs no build, so
 * `npm run fitness` answers in seconds. Neither project sees the other's files.
 *
 * The fitness project collects `*.test.ts` only: a `*.fitness.ts` is a module, not a test, and
 * `fitness/run.test.ts` is what loads every one of them and registers an `it` per claim.
 *
 * Which plugins' tests run is decided here, and only here (issue #828). With `WILANIS_TEST_PLUGINS=touched`,
 * which `npm test` sets, the tests under `packages/plugin-<name>/test` run only for a plugin with a file that
 * differs from the base: `WILANIS_TEST_BASE` when it is set (CI sets the pull request's or the merge queue's
 * base), and otherwise the merge base of HEAD with `origin/main`. Every other package, `libraries/` and
 * `fitness/` always run; a change to core or engine alone runs no plugin's tests, by decision. Without the
 * variable (`npm run test:all`, or `vitest` run by hand) every plugin runs, and so does a run whose changed
 * files cannot be listed. The run says on its first lines which plugins it tests and which it skips.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/** The repository's root: where this file is, whatever directory vitest was started from. */
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The output of one git command run at the root, or the reason it failed. */
function git(args: string[]): { out: string } | { failed: string } {
  try {
    return { out: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { failed: `git ${args.join(' ')} failed: ${(error as Error).message.split('\n')[0]}` };
  }
}

/** The revision the change is compared with: the one CI names, or the merge base with origin/main. */
function baseOf(): { base: string } | { failed: string } {
  const named = process.env.WILANIS_TEST_BASE;
  if (named) return { base: named };
  const found = git(['merge-base', 'HEAD', 'origin/main']);
  return 'out' in found ? { base: found.out.trim() } : found;
}

/** Every path that differs from the base, committed, staged, edited or new; a rename under both its names. */
function changedSince(base: string): { files: string[] } | { failed: string } {
  const diffed = git(['diff', '--no-renames', '--name-only', base, '--']);
  if ('failed' in diffed) return diffed;
  const added = git(['ls-files', '--others', '--exclude-standard']);
  if ('failed' in added) return added;
  return { files: `${diffed.out}\n${added.out}`.split('\n').filter(line => line !== '') };
}

/** The plugins this run tests and the ones it skips, with the reason, said once on the console. */
function choosePlugins(plugins: string[]): { tested: string[]; skipped: string[]; why: string } {
  const every = (why: string) => ({ tested: plugins, skipped: [], why });
  if (process.env.WILANIS_TEST_PLUGINS !== 'touched') return every('all: WILANIS_TEST_PLUGINS is not "touched"');
  const found = baseOf();
  if ('failed' in found) return every(found.failed);
  const changed = changedSince(found.base);
  if ('failed' in changed) return every(changed.failed);
  const touched = (name: string) => changed.files.some(file => file.startsWith(`packages/${name}/`));
  return {
    tested: plugins.filter(touched),
    skipped: plugins.filter(name => !touched(name)),
    why: `changed since ${found.base}`,
  };
}

/** The plugin packages under packages/, by directory name. */
const PLUGINS = readdirSync(`${ROOT}packages`).filter(name => name.startsWith('plugin-'));

/** What this run decided about the plugins' tests. */
const CHOSEN = choosePlugins(PLUGINS);

console.log(`plugins tested (${CHOSEN.why}): ${CHOSEN.tested.join(', ') || 'none'}`);
console.log(`plugins skipped (unchanged): ${CHOSEN.skipped.join(', ') || 'none'}`);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts', 'libraries/*/test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...CHOSEN.skipped.map(name => `packages/${name}/**`)],
        },
      },
      {
        test: {
          name: 'fitness',
          include: ['fitness/**/*.test.ts'],
        },
      },
    ],
  },
});
