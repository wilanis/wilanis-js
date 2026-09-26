/**
 * The viewer's manifest (RFC 0026, step 4): `/api/manifest` answers the bytes `wilanis manifest` prints, from the
 * one `manifestOf` and the one `manifestText`, every profile's block or the one `?profile=` names, and where the
 * command exits 1 it answers why; the project page opens it.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, type ManifestOptions, manifestOf } from '@wilanis/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveView, type ViewServer } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const STAGING =
  "no profile 'staging'; project.json declares: live (default), local, production, production-scheduler, production-worker";

/** What `wilanis manifest` prints for the tree at root: two-space JSON and a newline, as its own test pins it. */
async function printedBy(root: string, options: ManifestOptions): Promise<string> {
  return `${JSON.stringify(manifestOf(await loadProject(root), options), null, 2)}\n`;
}

let server: ViewServer;
beforeAll(async () => {
  server = await serveView(EXAMPLE, { port: 0 });
});
afterAll(async () => {
  await server.close();
});

/** What the viewer answers at /api/manifest with the query given: its status, content type and body. */
async function manifestAt(query = '') {
  const answer = await fetch(`${server.url}api/manifest${query}`);
  return { status: answer.status, type: answer.headers.get('content-type'), body: await answer.text() };
}

describe('/api/manifest', () => {
  it('answers the manifest as wilanis manifest prints it, every profile', { timeout: 60_000 }, async () => {
    const answer = await manifestAt();
    expect(answer.status).toBe(200);
    expect(answer.type).toContain('application/json');
    expect(answer.body).toBe(await printedBy(EXAMPLE, { root: EXAMPLE }));
    expect(Object.keys(JSON.parse(answer.body).profiles)).toContain('production');
    // an empty ?profile= is no profile, as an empty WILANIS_PROFILE is unset
    expect((await manifestAt('?profile=')).body).toBe(answer.body);
  });

  it('answers one profile where ?profile= names one, as --profile does', { timeout: 60_000 }, async () => {
    const answer = await manifestAt('?profile=production');
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(await printedBy(EXAMPLE, { root: EXAMPLE, profile: 'production' }));
    expect(Object.keys(JSON.parse(answer.body).profiles)).toEqual(['production']);
  });

  it("refuses a profile the project does not declare, with RFC 0013's message", { timeout: 60_000 }, async () => {
    const answer = await manifestAt('?profile=staging');
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toEqual({ error: STAGING });
  });

  it('answers the refusals of a tree the checker refuses, and no manifest', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-manifest-'));
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    symlinkSync(join(EXAMPLE, '../node_modules'), join(dir, 'node_modules'));
    const feature = join(dir, 'features/customers/feature.json');
    const doc = JSON.parse(readFileSync(feature, 'utf8'));
    doc.effects = doc.effects.filter((one: string) => one !== '@http/http.port.json#request');
    writeFileSync(feature, JSON.stringify(doc, null, 2));
    const broken = await serveView(dir, { port: 0 });
    try {
      const answer = await fetch(`${broken.url}api/manifest`);
      expect(answer.status).toBe(409);
      const body = (await answer.json()) as { error: string; refusals: { code: string }[]; format?: number };
      expect(body.error).toMatch(/^no manifest of a tree the checker refuses: \d+ refusal\(s\)$/);
      expect(body.refusals.map(refusal => refusal.code)).toContain('L003');
      expect(body.format).toBeUndefined();
    } finally {
      await broken.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the project page's manifest link", () => {
  it('opens /api/manifest from the project page, and each profile its own, where a server answers', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain(
      "a.href = '/api/manifest' + (profile === undefined ? '' : '?profile=' + encodeURIComponent(profile));",
    );
    expect(page).toMatch(
      /case 'project': \{[\s\S]*?if \(!STATIC\) \{ const m = el\('p'\); m\.appendChild\(manifestLink\(\)\)/,
    );
    expect(page).toContain(
      "if (p.name !== undefined && !STATIC) h.appendChild(el('code')).appendChild(manifestLink(p.name));",
    );
  });
});
