/**
 * RFC 0024's renderers, step 4: `imageFiles` and `composeFiles` over the plan of the committed manifest fixture, the
 * Compose file parsed back with `yaml` -- one service per workload, its command, ports, variables, read-only root and
 * probe; `.env.example` naming every variable and holding no value; the Dockerfile's base, user, ports and command;
 * the header on every file; and the one refusal the renderers make that `planOf` does not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  composeFiles,
  GENERATED,
  headerOf,
  imageFiles,
  majorOf,
  type Origin,
  type Plan,
  planOf,
  type Rendered,
  stamped,
} from '../src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE: Manifest = JSON.parse(readFileSync(join(HERE, 'fixtures/customers.manifest.json'), 'utf8'));
const LISTEN = '@http/server.port.json#listen';

/** The plan of these profiles, from a copy of the fixture the edit may change first. */
function plan(profiles: string[], edit: (manifest: Manifest) => void = () => {}): Plan {
  const manifest = structuredClone(FIXTURE);
  edit(manifest);
  return planOf(manifest, { profiles, image: 'customers:0.1.0' });
}

/** The plan of production, its one listener bound to this host. */
const boundTo = (host: string | null): Plan =>
  plan(['production'], manifest => {
    manifest.profiles.production.listens = [{ operation: LISTEN, host, port: 8099 }];
  });

/** One file of a render, by path; throws where the render has none so named. */
function fileOf(files: Rendered[], path: string): string {
  const file = files.find(one => one.path === path);
  if (!file) throw new Error(`no ${path} among ${files.map(one => one.path).join(', ')}`);
  return file.contents;
}

/** What the Compose file of a plan says, parsed back. */
const composed = (of: Plan) => parse(fileOf(composeFiles(of), 'compose.yaml'));

describe('compose: the Compose file', () => {
  const both = plan(['production', 'production-worker']);
  const { services } = composed(both);

  it('names the project after the tree, whatever directory the file is written into', () => {
    expect(composed(both).name).toBe('customers');
  });

  it('has one service per workload, named by the tree and the profile, each building the one image', () => {
    expect(Object.keys(services)).toEqual(['customers-production', 'customers-production-worker']);
    for (const service of Object.values<Record<string, unknown>>(services)) {
      expect(service.build).toEqual({ context: '..', dockerfile: 'deploy/Dockerfile' });
      expect(service.image).toBe('customers:0.1.0');
    }
  });

  it('starts each service with its workload’s command, and publishes the ports it listens on', () => {
    const [production, worker] = both.workloads;
    expect(services['customers-production'].command).toEqual(production?.command);
    expect(services['customers-production-worker'].command).toEqual(worker?.command);
    expect(services['customers-production'].ports).toEqual(['8099:8099']);
    expect(services['customers-production-worker'].ports).toBeUndefined();
  });

  it('quotes a port mapping, so no YAML 1.1 reader takes it for a number in base 60', () => {
    expect(fileOf(composeFiles(both), 'compose.yaml')).toContain('ports: ["8099:8099"]');
  });

  it('reads the variables from .env, on a read-only root with /tmp writable, restarting unless stopped', () => {
    for (const service of Object.values<Record<string, unknown>>(services)) {
      expect(service.env_file).toEqual(['.env']);
      expect(service.read_only).toBe(true);
      expect(service.tmpfs).toEqual(['/tmp']);
      expect(service.restart).toBe('unless-stopped');
    }
  });

  it('probes a service by a TCP connect on its first port, and a service that listens on nothing not at all', () => {
    const { healthcheck } = services['customers-production'];
    expect(healthcheck.test.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
    expect(healthcheck.test[3]).toContain("require('node:net').connect(8099)");
    expect(healthcheck).toMatchObject({ interval: '10s', timeout: '2s', retries: 6 });
    expect(services['customers-production-worker'].healthcheck).toBeUndefined();
  });

  it('names the service of the unnamed profile after the tree alone', () => {
    const unnamed = planOf(
      { ...FIXTURE, profiles: { '': FIXTURE.profiles.production } },
      {
        profiles: [''],
        image: 'customers:latest',
      },
    );
    expect(Object.keys(composed(unnamed).services)).toEqual(['customers']);
  });

  it('builds from the root and names the Dockerfile from it, wherever the files are written', () => {
    const elsewhere = planOf(FIXTURE, { profiles: ['production'], image: 'x:1', dockerfile: 'ops/compose/Dockerfile' });
    expect(composed(elsewhere).services['customers-production'].build).toEqual({
      context: '../..',
      dockerfile: 'ops/compose/Dockerfile',
    });
  });
});

describe('compose: .env.example', () => {
  const set: string[] = [];
  afterEach(() => {
    for (const variable of set.splice(0)) delete process.env[variable];
  });

  it('holds every variable name, an = and nothing after it, each under a comment naming its key and readers', () => {
    const production = plan(['production']);
    const variables = production.workloads.flatMap(workload => workload.needs.map(need => need.variable));
    for (const [at, variable] of variables.entries()) {
      process.env[variable] = `value-that-must-never-be-written-${at}`;
      set.push(variable);
    }
    const text = fileOf(composeFiles(production), '.env.example');
    const lines = text.split('\n').filter(line => line !== '' && !line.startsWith('#'));
    expect(lines).toEqual(variables.map(variable => `${variable}=`));
    expect(text).toContain('# secrets.jwt, read by @auth settings\nCUSTOMERS_JWT_SECRET=\n');
    expect(text).not.toContain('value-that-must-never-be-written');
  });

  it('names each variable once across the workloads, with every reader', () => {
    const text = fileOf(composeFiles(plan(['production', 'production-worker'])), '.env.example');
    expect(text.match(/^CUSTOMERS_JWT_SECRET=$/gm)).toHaveLength(1);
    expect(text).toContain("# every variable profiles 'production', 'production-worker' need;");
  });
});

describe('image: the Dockerfile', () => {
  const dockerfile = (of: Plan) => fileOf(imageFiles(of), 'Dockerfile');

  it('bases the image on the major of the tree’s engines.node, and on 22 where it names none', () => {
    expect(dockerfile(plan(['production']))).toMatch(/^FROM node:22-alpine$/m);
    const pinned = plan(['production'], manifest => {
      manifest.node = '>=24';
    });
    expect(dockerfile(pinned)).toMatch(/^FROM node:24-alpine$/m);
    expect([null, '>=22', '^20.11.0', '22.x', '>=20 <23', '<23', 'lts'].map(majorOf)).toEqual([
      22, 22, 20, 22, 20, 22, 22,
    ]);
  });

  it('installs as it ships and runs as the node user, the wilanis command on the path', () => {
    const text = dockerfile(plan(['production']));
    expect(text).toContain('COPY package.json package-lock.json ./\nRUN npm ci --omit=dev\nCOPY . .\n');
    expect(text).toMatch(/^USER node$/m);
    expect(text).toMatch(/^ENV PATH=\/app\/node_modules\/\.bin:\$PATH$/m);
  });

  it('exposes each port any workload listens on once, and starts the first workload’s command', () => {
    const three = plan(['live', 'production', 'production-worker'], manifest => {
      manifest.profiles.live.listens.push({ operation: '@admin/admin.port.json#serve', host: null, port: 9090 });
    });
    const text = dockerfile(three);
    expect(text.match(/^EXPOSE .*$/gm)).toEqual(['EXPOSE 8099', 'EXPOSE 9090']);
    expect(text).toMatch(/^CMD \["wilanis", "start", "\.", "--profile", "live"\]$/m);
    expect(text).not.toContain('production');
  });

  it('writes no value of a variable, and keeps every .env out of the build', () => {
    process.env.CUSTOMERS_JWT_SECRET = 'value-that-must-never-be-written';
    try {
      const files = imageFiles(plan(['production']));
      for (const file of files) expect(file.contents).not.toContain('value-that-must-never-be-written');
      expect(fileOf(files, 'Dockerfile.dockerignore').split('\n')).toContain('**/.env');
    } finally {
      delete process.env.CUSTOMERS_JWT_SECRET;
    }
  });
});

describe('the header', () => {
  const origin: Origin = { root: 'example', profiles: ['production'], flags: [] };

  it('is the first two lines of every rendered file, naming the tree, the profile and the command again', () => {
    const production = plan(['production']);
    for (const file of [...imageFiles(production), ...composeFiles(production)].map(one => stamped(one, origin))) {
      const [first, second] = file.contents.split('\n');
      expect(first).toBe(`${GENERATED} from example (profile production) -- do not edit`);
      expect(second).toBe('# regenerate: npx wilanis-deploy example --profile production');
    }
  });

  it('names every profile, the flags beyond, and quotes what a shell would not read back', () => {
    const header = headerOf({ root: 'my tree', profiles: ['', 'live'], flags: ['--target', 'helm', '-o', 'out'] });
    expect(header).toBe(
      `${GENERATED} from my tree (profiles '', live) -- do not edit\n` +
        "# regenerate: npx wilanis-deploy 'my tree' --profile '' --profile live --target helm -o out\n",
    );
  });
});

describe('a host a published port would not reach', () => {
  const Refused =
    `'${LISTEN}' binds 127.0.0.1 under profile 'production', which nothing outside the container can reach: a ` +
    "published port and a Service both arrive on the container's own address\n" +
    '→ drop "host" to bind every interface, which is what a container wants; to keep a loopback bind on purpose -- ' +
    'a sidecar sharing the network namespace -- render --target plan and write the objects yourself';

  it('is refused by compose, and neither by the plan nor by the image, which publish nothing', () => {
    const loopback = boundTo('127.0.0.1');
    expect(loopback.workloads[0]?.listens[0]?.host).toBe('127.0.0.1');
    expect(() => composeFiles(loopback)).toThrow(new Error(Refused));
    expect(() => imageFiles(loopback)).not.toThrow();
  });

  it('is no wildcard, no host at all, and no secret the operator fills in: each of those renders', () => {
    for (const host of ['0.0.0.0', '::', null, '{{secrets.bindHost}}']) {
      const bound = boundTo(host);
      expect(bound.workloads[0]?.listens[0]?.host).toBe(host);
      expect(composed(bound).services['customers-production'].ports).toEqual(['8099:8099']);
      expect(fileOf(imageFiles(bound), 'Dockerfile')).toContain('EXPOSE 8099');
    }
  });
});
