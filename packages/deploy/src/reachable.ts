/**
 * What a renderer that publishes a port refuses (RFC 0024), and `planOf` deliberately does not: an address bound to
 * a fixed interface a container will not be reached on. A published port and a Service both arrive on the
 * container's own address, so a listener on 127.0.0.1 starts, logs that it listens, and answers nobody. A plan is
 * what the tree says, and a sidecar sharing the network namespace may mean exactly that, so only the targets that
 * publish -- `compose`, and `helm` after it -- ask this. Like the plan's own refusals it has no code: it is what the
 * command verifies, not a checker rule.
 */
import type { Plan, PlanListen } from './plan.js';

/** The interfaces that mean every one: IPv4's and IPv6's. */
const WILDCARDS = ['0.0.0.0', '::'];

/** A host the operator fills in from the environment, kept as the tree writes it: a `{{secrets.*}}` read. */
const SECRET = /^\{\{\s*secrets\.[^}]+\}\}$/;

/** Whether a published port reaches what binds this host: every interface, a wildcard, or the operator's choice. */
export const reachable = (host: string | null): boolean =>
  host === null || WILDCARDS.includes(host) || SECRET.test(host);

/** The refusal of one address bound where nothing outside the container arrives, naming both ways out. */
const unreachableSaid = (profile: string, listen: PlanListen): string =>
  `'${listen.operation}' binds ${listen.host} under ${profile === '' ? 'the unnamed profile' : `profile '${profile}'`}, ` +
  "which nothing outside the container can reach: a published port and a Service both arrive on the container's own " +
  'address\n→ drop "host" to bind every interface, which is what a container wants; to keep a loopback bind on ' +
  'purpose -- a sidecar sharing the network namespace -- render --target plan and write the objects yourself';

/** Every address of the plan a published port would not reach, each a message and its hint; nothing where all do. */
export function unreachableOf(plan: Plan): string[] {
  return plan.workloads.flatMap(workload =>
    workload.listens.filter(listen => !reachable(listen.host)).map(listen => unreachableSaid(workload.profile, listen)),
  );
}
