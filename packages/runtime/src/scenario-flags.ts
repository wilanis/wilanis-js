/**
 * What the scenario commands are asked on the command line (RFC 0018): `rehearse --record [dir]` and `--check`,
 * `fuzz --edges` and its `--check`, and `scenarios --check`, each answered, before any run, as the options to run
 * with or the reason the flags are refused. Each refuses what would make a directory a command owns depend on more
 * than the tree: a seed, a profile, an envelope whose `ok` would not say whether the directory is current.
 */
import { resolve } from 'node:path';
import { BESIDE_EDGES } from './fuzz-edges.js';
import { RECORDED, refusedDir } from './recorded-dir.js';

/** What the command line asked of a command, or why it may not be asked. */
export type Asked<T> = { asked: T } | { refused: string };

type Flags = Record<string, string>;

/** What `--record` and `--check` refuse beside them, and why each is refused. */
const BESIDE_RECORDING: Record<string, string> = {
  seed: 'the recorded directory is solved under seed 1: drop --seed',
  profile:
    'the recorded directory is solved under the profile project.json marks "default": true, whatever --profile or ' +
    'WILANIS_PROFILE say, so that it is a function of the tree alone: drop --profile',
  json:
    "--json prints the rehearsal's envelope, whose ok does not say whether the recorded directory is current, and " +
    "an envelope for staleness is RFC 0019's to add: drop --json",
};

/** Why the first flag given that `refusals` names is refused beside the others; nothing where none is given. */
function besideOf(flags: Flags, refusals: Record<string, string>): string | undefined {
  const beside = Object.keys(refusals).find(flag => flags[flag] !== undefined);
  return beside && refusals[beside];
}

/**
 * What `rehearse` is asked to record: `--record [dir]` and `--check`, `--record --check` being `--check` on that
 * directory. Either refuses `--seed` and `--profile`, since the recorded directory is a function of the tree alone,
 * solved under one fixed seed and the default profile, and `--json`, since the envelope's `ok` is the rehearsal's
 * and the exit code would be the directory's; and a directory it may not own (`refusedDir`).
 */
export function recordingOf(flags: Flags, root: string): Asked<{ record?: string; check?: boolean }> {
  const check = flags.check !== undefined;
  if (flags.record === undefined && !check) return { asked: {} };
  const record = flags.record === undefined || flags.record === 'true' ? RECORDED : flags.record;
  const refused = besideOf(flags, BESIDE_RECORDING) ?? refusedDir(resolve(root), record);
  return refused ? { refused } : { asked: { record, ...(check ? { check } : {}) } };
}

/**
 * What `fuzz` is asked to write instead of its seeds' runs: `--edges`, and `--check` beside it. Either refuses what
 * would make the edges directory depend on more than the tree (`BESIDE_EDGES`), and `--check` alone is refused,
 * since the edges directory is the one fuzz's check judges.
 */
export function edgingOf(flags: Flags): Asked<{ edges?: boolean; check?: boolean }> {
  const [edges, check] = [flags.edges !== undefined, flags.check !== undefined];
  if (!edges && !check) return { asked: {} };
  if (!edges) return { refused: '--check judges what fuzz --edges wrote: fuzz --edges --check' };
  const refused = besideOf(flags, BESIDE_EDGES);
  return refused ? { refused } : { asked: { edges, ...(check ? { check } : {}) } };
}

/**
 * What `scenarios` is asked: `--check`, its one form, and nothing beside it, since it runs `rehearse --check` and
 * `fuzz --edges --check` as they are, under seed 1 and the default profile, and prints no envelope.
 */
export function scenariosOf(flags: Flags): Asked<{ check: true }> {
  if (flags.check === undefined)
    return {
      refused: 'wilanis scenarios checks the directories rehearse --record and fuzz --edges write: add --check',
    };
  const other = Object.keys(flags).find(flag => flag !== 'check');
  if (other === 'json')
    return {
      refused: "wilanis scenarios prints no envelope, and an envelope for staleness is RFC 0019's to add: drop --json",
    };
  if (other)
    return {
      refused: `wilanis scenarios --check runs both checks as they are, under seed 1 and the default profile: drop --${other}`,
    };
  return { asked: { check: true } };
}
