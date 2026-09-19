/**
 * A port a plugin requires (RFC 0005): it ships under the plugin's docs/ and the host binds it. The loader
 * registers it as an open domain port, so B002 holds a tree to binding it under every profile and says which
 * plugin requires it; D012 refuses a manifest that grants and requires one path, or requires one it does not
 * ship; `describe` says who requires the port and what each profile binds it to.
 */
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, ls } from '../src/index.js';
import { keeper, PROFILES, reading, refusals } from './required-harness.js';

describe('a port a plugin requires', () => {
  it('is registered as a domain port the plugin requires, not a native one', async () => {
    await reading(true, keeper(), load => {
      const memory = load.registry.get('port', '@keep/memory.port.json');
      expect(memory?.native).toBeUndefined();
      expect(memory?.requiredBy).toBe('@keep');
      expect(load.registry.get('port', '@keep/files.port.json')?.native).toBe('@keep');
      expect(ls(load, 'port')).toContain(`${'port'.padEnd(16)} @keep/memory.port.json  (required by @keep)`);
    });
  });

  it('checks clean once every profile binds it', async () => {
    expect(await refusals(true)).toEqual([]);
  });

  it('B002 under every profile while nothing binds it, naming the plugin that requires it', async () => {
    expect(await refusals(false)).toEqual(
      PROFILES.map(
        profile =>
          `B002 profile '${profile}': no binding implements port '@keep/memory.port.json' (required by @keep) → wilanis new binding <feature>/<name> --port @keep/memory.port.json`,
      ),
    );
  });

  it('D012 when the manifest both grants and requires one path', async () => {
    const both = keeper(grants => grants.push('@keep/memory.port.json'));
    expect(await refusals(true, both)).toEqual([
      "D012 '@keep/memory.port.json' is both granted and required: a port is the plugin's to implement or the host's to bind, never both → list it once: under grants.ports if the plugin implements it, under requires.ports if the host binds it",
    ]);
  });

  it('D012 when the manifest requires a port it does not ship', async () => {
    const absent = keeper((_, requires) => requires.push('@keep/absent.port.json', '@http/http.port.json'));
    const codes = (await refusals(true, absent)).map(said => said.split(' ')[0]);
    expect(codes).toEqual(['D012', 'D012']);
  });

  it('describe says who requires it, and what each profile binds it to', async () => {
    const bound = (indent: string) =>
      PROFILES.map(profile => `${indent}bound by  profile ${profile} → @features/keeping/data/keep-files.binding.json`);
    await reading(true, keeper(), load => {
      expect(describeDoc(load, '@keep/memory.port.json')).toContain(['required by  @keep', ...bound('')].join('\n'));
      expect(describeDoc(load, '@keep/plugin.json')).toContain(
        ['requires (the host binds each):', '  @keep/memory.port.json', ...bound('    ')].join('\n'),
      );
    });
    await reading(false, keeper(), load => {
      expect(describeDoc(load, '@keep/memory.port.json')).toContain(
        `bound by  profile ${PROFILES[0]} → nothing -- no binding implements port '@keep/memory.port.json'`,
      );
    });
  });
});
