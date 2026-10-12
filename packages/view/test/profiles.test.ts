/**
 * The project page's profiles (RFC 0013, step 5): a block per profile, the same rows `wilanis describe
 * project.json` prints -- binds, stands in, reaches, holds, permits (RFC 0016), starts, needs -- from the same
 * `profilesOf`, so the page and the terminal never say different things about where a tree runs.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe as describeDoc, groupSaid, loadProject, needSaid, permitsSaid } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { viewOf } from '../src/index.js';
import { type Drawn, lifted, PAGE, words } from './page-harness.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));

describe("the project page's profiles", () => {
  it('carries a block per profile, what describe prints, from the same function', async () => {
    const load = await loadProject(EXAMPLE);
    const project = viewOf(load, '@project.json');
    expect(project?.profiles?.map(profile => profile.name)).toEqual([
      'live',
      'local',
      'production',
      'production-scheduler',
      'production-worker',
    ]);
    const production = project?.profiles?.find(profile => profile.name === 'production');
    const said = describeDoc(load, 'project.json');
    for (const group of [...(production?.reaches ?? []), ...(production?.holds ?? [])])
      expect(said).toContain(groupSaid(group));
    for (const need of production?.needs ?? []) expect(said).toContain(needSaid(need));
    expect(production?.needs.map(need => need.variable)).toEqual([
      'CUSTOMERS_DATABASE_URL',
      'CUSTOMERS_JWT_SECRET',
      'CUSTOMERS_OPERATOR_PASSWORD_HASH',
    ]);
    expect(production?.standsIn).toEqual([
      {
        named: '@connections/employees.connection.json',
        standIn: '@connections/employees-production.connection.json',
      },
      {
        named: '@connections/jobs.connection.json',
        standIn: '@connections/customers-postgres.connection.json',
      },
    ]);
    expect(production?.reaches).toContainEqual({
      port: '@storage/store.port.json',
      operations: ['find', 'get', 'newKey', 'put', 'remove'],
      connections: ['@connections/customers-postgres.connection.json'],
    });
    expect(production?.holds.map(group => group.port)).toContain('@http/server.port.json');
  });

  it('carries the permits each profile writes, and none for a profile that permits everything', async () => {
    const load = await loadProject(EXAMPLE);
    const profiles = viewOf(load, '@project.json')?.profiles ?? [];
    const production = profiles.find(profile => profile.name === 'production');
    expect(production?.permits).toContain('@storage/storage.port.json#ensure');
    expect(production?.permits).toContain('@connections/customers-postgres.connection.json');
    const writing = ['production', 'production-scheduler', 'production-worker'];
    for (const name of writing)
      expect(profiles.find(profile => profile.name === name)?.permits).toEqual(
        load.registry.project?.doc.profiles?.[name].permits,
      );
    for (const open of profiles.filter(profile => !writing.includes(profile.name)))
      expect(open.permits).toBeUndefined();
    const said = describeDoc(load, 'project.json');
    for (const profile of profiles) expect(said).toContain(`  permits    ${permitsSaid(profile)}`);
  });

  it('marks the default, and starts under a profile only the steps that run there', async () => {
    const project = viewOf(await loadProject(EXAMPLE), '@project.json');
    const [live, local, production] = project?.profiles ?? [];
    expect([live.default, local.default, production.default]).toEqual([true, false, false]);
    for (const laptop of [live, local]) expect(laptop.starts.map(step => step.label)).toContain('Watch for changes');
    expect(production.starts.map(step => step.label)).not.toContain('Watch for changes');
    expect(production.holds.map(group => group.port)).not.toContain('@reload/watch.port.json');
  });

  it('shows the one process that schedules and the instances that only listen (RFC 0010)', async () => {
    const project = viewOf(await loadProject(EXAMPLE), '@project.json');
    const ports = (name: string) =>
      project?.profiles?.find(profile => profile.name === name)?.holds.map(group => group.port) ?? [];
    expect(ports('production')).toContain('@http/server.port.json');
    expect(ports('production')).not.toContain('@schedule/scheduler.port.json');
    expect(ports('production-scheduler')).toContain('@schedule/scheduler.port.json');
    expect(ports('production-scheduler')).not.toContain('@http/server.port.json');
  });

  it('shows the processes that work the queue apart from the instances that listen (RFC 0009)', async () => {
    const project = viewOf(await loadProject(EXAMPLE), '@project.json');
    const ports = (name: string) =>
      project?.profiles?.find(profile => profile.name === name)?.holds.map(group => group.port) ?? [];
    expect(ports('production')).not.toContain('@queue/worker.port.json');
    expect(ports('production-worker')).toContain('@queue/worker.port.json');
    expect(ports('production-worker')).not.toContain('@http/server.port.json');
    expect(ports('production-worker')).not.toContain('@schedule/scheduler.port.json');
  });

  it('draws the seven rows describe prints, and the default as a badge', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('if (v.profiles) profilesEl(page, v.profiles);');
    const rows = ["row('binds'", "row('stands in'", "row('reaches'", "row('holds'", "row('permits'", "row('starts'"];
    for (const row of [...rows, "row('needs'"]) expect(page).toContain(row);
    expect(page).toContain(
      "row('permits', (p.permits || []).map(entry => p.permitsFrom ? frag(permitEl(entry), inheritedEl(p.permitsFrom.profile)) : permitEl(entry)), 'everything (no permits)');",
    );
    expect(page).toMatch(/if \(p\.default\) h\.appendChild\(el\('span', 'badge ok', 'default'\)\)/);
    expect(page).toMatch(/function groupEl\(g\)[\s\S]*?' {2}via '/);
  });

  it('names beside the heading the profile it extends, and marks each row it takes from it (RFC 0043)', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('h.id = profileId(p.name);');
    expect(page).toContain('if (p.extends) h.appendChild(extendsEl(p.extends));');
    expect(page).toContain(
      "row('binds', p.binds.map(b => pair(b.port, b.binding, b.from)), 'each port’s one binding');",
    );
    expect(page).toContain("row('stands in', p.standsIn.map(s => pair(s.named, s.standIn, s.from)), '');");
    const { extendsEl, inheritedEl, profileId } = await lifted('extendsEl', 'inheritedEl', 'profileId');
    const extended = extendsEl('production') as Drawn & { onclick?: unknown };
    expect(words(extended)).toBe('extends production');
    expect(extended).toMatchObject({ tag: 'span', cls: 'tag' });
    // a link to the parent's block on this page: it scrolls there, since the hash names the document shown
    expect(extended.children[0]).toMatchObject({ tag: 'a', text: 'production' });
    expect(typeof (extended.children[0] as Drawn & { onclick?: unknown }).onclick).toBe('function');
    expect(profileId('production')).toBe('profile-production');
    expect(words(inheritedEl('production') as Drawn)).toBe('from production');
  });

  it('draws an entry of permits as the port or connection it names, linked, and the operation beside it', async () => {
    const { permitEl } = await lifted('permitEl');
    const operation = permitEl('@storage/storage.port.json#ensure') as Drawn;
    expect(words(operation)).toBe('@storage/storage.port.json #ensure');
    expect(operation.children[0]).toMatchObject({ tag: 'a', path: '@storage/storage.port.json' });
    const connection = permitEl('@connections/customers-postgres.connection.json') as Drawn;
    expect(connection).toMatchObject({ tag: 'a', path: '@connections/customers-postgres.connection.json' });
  });
});
