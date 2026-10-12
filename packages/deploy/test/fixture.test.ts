/**
 * The manifest fixture the other tests read is what `wilanis manifest example` prints today: this case loads the
 * example once, so the plan and the renderers are tested against a manifest the tree produces, not one that was.
 *
 * The fixture is generated, never written by hand. When the example changes, regenerate it with
 *   npx vitest run packages/deploy/test/fixture.test.ts -u
 * and read the diff: it is a diff of what the tree is, and the goldens of the other tests move only where a plan does.
 */
import { fileURLToPath } from 'node:url';
import { loadProject, manifestOf } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));

describe('the manifest fixture', () => {
  it('is what `wilanis manifest example` prints', async () => {
    const manifest = manifestOf(await loadProject(EXAMPLE), { root: 'example' });
    await expect(`${JSON.stringify(manifest, null, 2)}\n`).toMatchFileSnapshot('./fixtures/customers.manifest.json');
  });
});
