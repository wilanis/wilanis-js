/**
 * From a demand that a text hold some words and lack others (`contains`, RFC 0040) to a text that does: the smallest
 * change to a text that makes it so, or nothing where no change this module knows makes one.
 */
import { type Domain, fits } from './domains.js';

/** Whether a domain asks a text to hold or to lack a word. */
export function asksWords(domain: Domain): boolean {
  return Boolean(domain.contains?.length || domain.omits?.length);
}

/**
 * `base` changed to meet the words the domain asks for: every word it must lack taken out, every word it must hold and
 * does not appended after a space, then padded to the least length with `pad`. Where that text does not fit -- an
 * append made a word it must lack across the join, or the text is too long -- the words it must hold alone, joined by a
 * space; undefined where neither fits.
 */
export function withWords(domain: Domain, base: string, pad: string): string | undefined {
  const held = domain.contains ?? [];
  const changed = padded(withHeld(withoutOmitted(base, domain.omits ?? []), held), domain, pad);
  if (fitsText(changed, domain)) return changed;
  const alone = padded(held.join(' '), domain, pad);
  return fitsText(alone, domain) ? alone : undefined;
}

/** The text less every word it must lack, again until none is left: 'hhpp' without 'hp' is '', not 'hp'. */
function withoutOmitted(text: string, omits: string[]): string {
  let out = text;
  while (omits.some(word => out.includes(word))) for (const word of omits) out = out.split(word).join('');
  return out;
}

/** The text with each word it must hold and does not appended, after a space. */
function withHeld(text: string, held: string[]): string {
  let out = text;
  for (const word of held) if (!out.includes(word)) out = out ? `${out} ${word}` : word;
  return out;
}

/** The text padded with `pad` to the least length the domain asks for, as `withChars` pads. */
function padded(text: string, domain: Domain, pad: string): string {
  return text.padEnd(domain.minLen ?? 0, pad);
}

/** Whether a text meets the domain: the words it holds and lacks, its exclusions, and the length it is held to. */
export function fitsText(text: string, domain: Domain): boolean {
  if (domain.minLen !== undefined && text.length < domain.minLen) return false;
  if (domain.maxLen !== undefined && text.length > domain.maxLen) return false;
  return fits(text, domain);
}
