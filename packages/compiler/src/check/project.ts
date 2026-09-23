/**
 * The project document. C connections/settings: plugin settings read secrets only and fit the manifest (C001,
 * C002), and every declared secret is read by something (C019). The profiles are judged in `profiles.ts`
 * (C017, C018, R001, B002, B003, B004, B011). Startup: each step fires a domain port operation (or a native one
 * that holds) before anything is received, under profiles the project declares (B006, B007, B008, B012). Blobs:
 * the connection the blob registry keeps bytes behind opens a store some plugin offers (C014).
 */
import { EMPTY_OBJECT, type Operation, type PluginModule, runsUnder, type StartupStep } from '@wilanis/core';
import { type Judge, underProfile } from './judge.js';
import { checkProfiles } from './profiles.js';
import { opNeeds } from './resolvers.js';
import { mismatch } from './typing.js';

/**
 * The refusals for the project document: plugin settings read secrets only and fit the manifest (C001, C002),
 * every secret is read (C019), and the profiles (`checkProfiles`).
 */
export function checkProject(judge: Judge): void {
  checkPluginSettings(judge);
  checkSecretsRead(judge);
  checkProfiles(judge);
}

/** C001, C002: a plugin's settings read secrets only and fit what its manifest declares. */
function checkPluginSettings(judge: Judge): void {
  const { path, doc } = judge.project;
  const refuse = judge.refuser(path);
  for (const [index, use] of doc.plugins.entries()) {
    const manifest = judge.scope.registry.get('plugin', `${use.use}/plugin.json`);
    if (!manifest) continue;
    const at = `plugins/${index}/settings`;
    const declared = manifest.doc.settings ? judge.type(manifest.doc.settings, path, `plugins/${index}`) : EMPTY_OBJECT;
    const read = judge.settingsRead(use.settings ?? {}, path, at);
    const bad = mismatch(read?.type, declared);
    if (bad) refuse('C002', `plugin '${use.use}' settings: ${bad}`, at, `wilanis describe ${use.use}/plugin.json`);
  }
}

/**
 * C019: a declared secret is read by something -- a plugin's settings, a connection's settings, or a startup
 * step's `in`, the three places a document may read one. A key nothing reads still costs every place it runs a
 * variable to set.
 */
function checkSecretsRead(judge: Judge): void {
  const { path, doc } = judge.project;
  const read = new Set<string>();
  const note = (value: unknown) => {
    for (const [root, key] of judge.scope.templateReads(value)) if (root === 'secrets' && key) read.add(key);
  };
  for (const use of doc.plugins) note(use.settings);
  for (const connection of judge.scope.registry.all('connection')) note(connection.doc.settings);
  for (const step of doc.startup ?? []) note(step.in);
  for (const [key, variable] of Object.entries(doc.secrets ?? {})) {
    if (read.has(key)) continue;
    judge.refuser(path)(
      'C019',
      `secret '${key}' (${variable}) is read by nothing: no plugin's settings, no connection's settings, no startup step's in`,
      `secrets/${key}`,
      `remove it from project.json → secrets, or read it as {{secrets.${key}}}`,
    );
  }
}

/**
 * The project's startup steps: each fires a domain port operation once, before any trigger kind starts.
 * A step runs with nothing received, so it may neither fire a native operation nor reach a read of
 * request.*; its inputs must meet the operation's contract, written as literals and secrets.
 */
export function checkStartup(judge: Judge): void {
  for (const [index, step] of (judge.project.doc.startup ?? []).entries()) checkStep(judge, step, index);
}

function checkStep(judge: Judge, step: StartupStep, index: number): void {
  const refuse = judge.refuser(judge.project.path);
  const at = `startup/${index}/run`;
  checkStepProfiles(judge, step, index);
  const hit = judge.scope.op(step.run);
  if (typeof hit === 'string') {
    refuse('B006', `startup step ${index}: ${hit}`, at, 'wilanis ls port');
    return;
  }
  // a `holds` operation starts something that outlives the run -- a listener, a watcher. It is a plugin's
  // to implement and has no per-profile binding, so a startup step names it directly.
  if (hit.port.native && !hit.op.holds) {
    const hint = "a startup step fires a domain port; the port's binding reaches the native operation";
    refuse('B006', `startup step ${index} fires native operation '${step.run}'`, at, hint);
    return;
  }
  checkStepInputs(judge, step, index, hit.op);
  checkStepReads(judge, step, index);
}

/** B012: every profile a step names is one the project declares. */
function checkStepProfiles(judge: Judge, step: StartupStep, index: number): void {
  const declared = judge.scope.profiles();
  const list = declared.length ? declared.join(', ') : '(project.json declares none; remove profiles)';
  for (const [at, name] of (step.profiles ?? []).entries()) {
    if (declared.includes(name)) continue;
    judge.refuser(judge.project.path)(
      'B012',
      `startup step ${index} runs under profile '${name}', which project.json does not declare`,
      `startup/${index}/profiles/${at}`,
      `name a declared profile: ${list}`,
    );
  }
}

/** B007: a step's inputs are literals and secrets that meet the operation's contract. */
function checkStepInputs(judge: Judge, step: StartupStep, index: number, op: Operation): void {
  const refuse = judge.refuser(judge.project.path);
  const at = `startup/${index}/in`;
  const takes = judge.acceptsType(op);
  const why = 'a startup step runs before anything is received; only {{secrets.<key>}} may appear';
  const read = judge.secretsRead(step.in ?? {}, why);
  if (typeof read === 'string') {
    refuse(
      'B007',
      `startup step ${index}: ${read}`,
      at,
      'write the value, or declare the key under project.json → secrets',
    );
    return;
  }
  const bad = mismatch(read?.type, takes);
  if (bad)
    refuse('B007', `startup step ${index} → ${step.run}: ${bad}`, at, `wilanis describe ${step.run.split('#')[0]}`);
  if (!takes && Object.keys(step.in ?? {}).length)
    refuse('B007', `startup step ${index}: '${step.run}' takes no input`, at, 'remove in');
}

/** B008: nothing has been received when a step runs, so no read of request.* can be met, under any profile it runs under. */
function checkStepReads(judge: Judge, step: StartupStep, index: number): void {
  const refuse = judge.refuser(judge.project.path);
  const hint = 'fire this operation from a trigger, or bind the port to a graph that reads no request';
  for (const profile of judge.profiles().filter(one => runsUnder(step, one))) {
    for (const need of opNeeds(judge, step.run, profile)) {
      const message = `startup step ${index}: ${need.file} reads request.${need.path.join('.')}, but a startup step runs before anything is received${underProfile(profile)}`;
      refuse('B008', message, `startup/${index}/run`, hint);
    }
  }
}

/**
 * C014: `blobs.connection` names a connection, and a plugin the project names offers a blob store for its kind.
 * What a plugin offers is its module's `blobStores`, so this is judged against the plugins the tree loaded.
 */
export function checkBlobStore(judge: Judge, plugins: PluginModule[]): void {
  const ref = judge.project.doc.blobs?.connection;
  if (!ref) return;
  const refuse = judge.refuser(judge.project.path);
  const connection = judge.scope.get('connection', ref);
  if (!connection) {
    refuse(
      'C014',
      `blobs.connection names '${ref}', which is no connection`,
      'blobs/connection',
      'wilanis ls connection',
    );
    return;
  }
  const kind = judge.scope.canon(connection.doc.kind);
  if (plugins.some(plugin => plugin.blobStores?.[kind])) return;
  refuse(
    'C014',
    `blobs.connection names '${ref}', of kind '${kind}', and no plugin the project names offers a blob store for that kind`,
    'blobs/connection',
    'wilanis ls connection-kind; name a plugin that offers a blob store for one, or remove blobs.connection to keep files',
  );
}
