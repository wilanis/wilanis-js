/**
 * RFC 0024's chart, step 5, held to the target that writes its values, with no helm binary: `charts/wilanis-tree`
 * takes every key `helmFiles` writes and deploys nothing on its own values, each dependency in `Chart.yaml` is pinned
 * and behind one of the switches the target turns off, `Chart.lock` pins the same, and `values-local.yaml` answers
 * every variable of the example's values. What the templates render from them is `helm lint` and `helm template`, in
 * CI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CHART, helmFiles, planOf, SWITCHES } from '../src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE: Manifest = JSON.parse(readFileSync(join(HERE, 'fixtures/customers.manifest.json'), 'utf8'));

/** A YAML file of this repository, parsed. */
const yamlAt = (path: string) => parse(readFileSync(join(REPOSITORY, path), 'utf8'));

describe('charts/wilanis-tree', () => {
  const chart = yamlAt(join(CHART, 'Chart.yaml'));
  const defaults = yamlAt(join(CHART, 'values.yaml'));
  const [values] = helmFiles(planOf(FIXTURE, { profiles: ['production', 'production-worker'], image: 'x:1' }));
  const written = parse(values?.contents ?? '');

  it('takes every key the helm target writes, and deploys nothing on its own values', () => {
    expect(Object.keys(defaults)).toEqual(expect.arrayContaining(Object.keys(written)));
    expect(Object.keys(defaults.image)).toEqual(Object.keys(written.image));
    expect(Object.keys(defaults.secret)).toEqual(expect.arrayContaining(Object.keys(written.secret)));
    expect(defaults).toMatchObject({ name: '', workloads: [], requires: [] });
    expect(defaults.secret).toMatchObject({ existingSecret: '', keys: [], create: false });
  });

  it('turns every switch off, as the values the target writes do', () => {
    for (const name of SWITCHES) expect([name, defaults[name].enabled]).toEqual([name, false]);
  });

  it('puts every dependency behind one of the switches, pinned to one version, as Chart.lock pins it', () => {
    expect(chart.apiVersion).toBe('v2');
    const dependencies: { name: string; version: string; condition: string }[] = chart.dependencies;
    expect(dependencies.map(dependency => dependency.condition)).toEqual(SWITCHES.map(name => `${name}.enabled`));
    for (const { version } of dependencies) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const pinned = (list: { name: string; version: string }[]) => list.map(({ name, version }) => ({ name, version }));
    expect(pinned(yamlAt(join(CHART, 'Chart.lock')).dependencies)).toEqual(pinned(dependencies));
  });

  it('answers every variable of the example’s values in values-local.yaml, from the database or the Secret', () => {
    const local = yamlAt(join(CHART, 'values-local.yaml'));
    const example = yamlAt('example/deploy/values.yaml');
    const answered = [...local.postgresql.variables, ...Object.keys(local.secret.values)].sort();
    expect(answered).toEqual(example.secret.keys);
    const listened = example.workloads.flatMap((workload: { profile: string; ports: { port: number }[] }) =>
      workload.ports.map(({ port }) => `${workload.profile}/${port}`),
    );
    const exposed = Object.entries<Record<string, number>>(local.service.nodePorts).flatMap(([profile, ports]) =>
      Object.keys(ports).map(port => `${profile}/${port}`),
    );
    expect(listened).toEqual(expect.arrayContaining(exposed));
  });
});
