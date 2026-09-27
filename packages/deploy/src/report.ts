/**
 * What `wilanis-deploy` says on stderr once it has rendered files, as the Guide of RFC 0024 prints it: what the plan
 * holds, what was written, and the command that takes it from there -- or, under `--check`, what a write would change
 * and the command that writes it. stdout is the plan's alone, so none of this is printed there.
 */
import { CHART } from './helm.js';
import type { Plan } from './plan.js';
import type { Written } from './write.js';

/** Everything the report is made from: the plan, the targets, where the files went, and what writing them did. */
export interface Report {
  plan: Plan;
  targets: string[];
  places: { root: string; out: string };
  written: Written;
  check: boolean;
  /** The words of the command line as it was run, `--check` aside, each as a shell reads it back. */
  again: string[];
}

/** A count and its noun, the noun made plural where the count is not one. */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The plan in one line: its workloads by profile, its ports, its variables, and the hosts the environment provides. */
function summaryOf(plan: Plan): string {
  const profiles = plan.workloads.map(workload => (workload.profile === '' ? "''" : workload.profile));
  const ports = new Set(plan.workloads.flatMap(workload => workload.listens.map(listen => listen.port)));
  const variables = new Set(plan.workloads.flatMap(workload => workload.needs.map(need => need.variable)));
  return (
    `plan: ${counted(plan.workloads.length, 'workload')} (${profiles.join(', ')}), ${counted(ports.size, 'port')}, ` +
    `${counted(variables.size, 'variable')}, ${counted(plan.requires.length, 'host')} required`
  );
}

/** The commands that take the written files from there: the image's build, the Compose file's start, the install. */
function nextOf({ plan, targets, places }: Report): string[] {
  return [
    ...(targets.includes('image')
      ? [`→ docker build -f ${places.out}/Dockerfile -t ${plan.image.reference} ${places.root}`]
      : []),
    ...(targets.includes('compose') ? [`→ docker compose -f ${places.out}/compose.yaml up --build`] : []),
    ...(targets.includes('helm') ? [`→ helm install ${plan.name} ${CHART} -f ${places.out}/values.yaml`] : []),
  ];
}

/** What `--check` says: every file that would change and the command that writes them, or that none would. */
function checkedOf({ written, places, again }: Report): string[] {
  if (written.ok) return [`${places.out}: every file is as the tree renders it`];
  return [...written.said, `→ ${['npx', 'wilanis-deploy', ...again].join(' ')}`];
}

/** The lines said on stderr once files were rendered, joined. */
export function reported(report: Report): string {
  if (report.written.refused) return report.written.said.join('\n\n');
  if (report.check) return checkedOf(report).join('\n');
  return [summaryOf(report.plan), ...report.written.said, ...nextOf(report)].join('\n');
}
