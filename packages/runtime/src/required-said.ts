/**
 * What `wilanis describe` says of a port a plugin requires: which plugin calls it, and what each profile binds
 * it to -- the host's choice, so the one place a reader learns where that plugin's calls land.
 */
import type { Loaded, PluginDoc, Scope } from '@wilanis/core';

/** One `bound by` line per profile (one line when the project declares none): the binding chosen, or why there is none. */
function boundLines(port: string, scope: Scope, indent = ''): string[] {
  const profiles = scope.profiles();
  return (profiles.length ? profiles : [undefined]).map(profile => {
    const found = scope.bindingFor(port, profile);
    const bound = typeof found === 'string' ? `nothing -- ${found}` : found.path;
    return `${indent}bound by  ${profile ? `profile ${profile} → ` : ''}${bound}`;
  });
}

/** Who requires one port, and the package it came from, then what each profile binds it to. */
export function requiredByLines(doc: Loaded, from: string | undefined, scope: Scope): string[] {
  return [`required by  ${doc.requiredBy}${from ? `  (${from})` : ''}`, ...boundLines(doc.path, scope)];
}

/** The ports one plugin requires, each with what each profile binds it to; nothing when it requires none. */
export function requiresLines(doc: Loaded, scope: Scope): string[] {
  const ports = (doc.doc as PluginDoc).requires?.ports ?? [];
  if (!ports.length) return [];
  return [
    'requires (the host binds each):',
    ...ports.flatMap(port => [`  ${port}`, ...boundLines(scope.canon(port), scope, '    ')]),
  ];
}
