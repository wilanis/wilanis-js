/**
 * The project page's profiles (RFC 0013, step 5): a block per profile, the same rows `wilanis describe
 * project.json` prints -- binds, stands in, reaches, holds, starts, needs -- from the same `profilesOf`, so the
 * page and the terminal never say different things about where a tree runs.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe as describeDoc, groupSaid, loadProject, needSaid } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));

describe("the project page's profiles", () => {
  it('carries a block per profile, what describe prints, from the same function', async () => {
    const load = await loadProject(EXAMPLE);
    const project = viewOf(load, '@project.json');
    expect(project?.profiles?.map(profile => profile.name)).toEqual([
      'live',
      'local',
      'production',
      'production-scheduler',
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
    ]);
    expect(production?.reaches).toContainEqual({
      port: '@storage/store.port.json',
      operations: ['find', 'get', 'newKey', 'put', 'remove'],
      connections: ['@connections/customers-postgres.connection.json'],
    });
    expect(production?.holds.map(group => group.port)).toContain('@http/server.port.json');
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

  it('draws the six rows describe prints, and the default as a badge', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('if (v.profiles) profilesEl(page, v.profiles);');
    for (const row of ["row('binds'", "row('stands in'", "row('reaches'", "row('holds'", "row('starts'", "row('needs'"])
      expect(page).toContain(row);
    expect(page).toMatch(/if \(p\.default\) h\.appendChild\(el\('span', 'badge ok', 'default'\)\)/);
    expect(page).toMatch(/function groupEl\(g\)[\s\S]*?' {2}via '/);
  });
});
