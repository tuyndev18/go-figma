// Defaults for the tags that merge selected frames into one page: a breakpoint
// (responsive page) or a state name (one page, several states). Shared by the
// plugin window, which proposes them, and the sandbox, which stores them.
import { BREAKPOINTS, type Breakpoint } from "./ir";
import { toKebab } from "./naming";

/** State names end up in `data-state="…"` and Tailwind's `data-[state=…]:`, so they are kebab-case. */
export const toStateName = (value: string) => toKebab(value);

/** Breakpoint per frame from its name ("Mobile Landing"), else its width; a tier already taken is left out. */
export function guessBreakpoints(frames: { name: string; width: number }[]): (Breakpoint | undefined)[] {
  const used = new Set<Breakpoint>();
  return frames.map(({ name, width }) => {
    const named = name.match(/\b(mobile|tablet|desktop)\b/i)?.[1].toLowerCase() as Breakpoint | undefined;
    const tier = named ?? [...BREAKPOINTS].reverse().find((b) => width >= b.minWidth)!.name;
    if (used.has(tier)) return undefined;
    used.add(tier);
    return tier;
  });
}

/**
 * State name per frame: what sets its name apart from the others.
 * "Login Default" / "Login Error" → "default" / "error"; "Checkout Step 1" / "Checkout Step 2" → "step-1" / "step-2".
 */
export function defaultStateNames(names: string[]): string[] {
  const words = names.map((name) => toKebab(name).split("-").filter(Boolean));
  const shortest = Math.min(...words.map((w) => w.length));
  const same = (at: (w: string[]) => string | undefined) => words.every((w) => at(w) === at(words[0]));

  // Every name keeps at least one word of its own.
  let start = 0;
  while (start < shortest - 1 && same((w) => w[start])) start++;
  let end = 0;
  while (end < shortest - 1 - start && same((w) => w[w.length - 1 - end])) end++;

  const used = new Set<string>();
  return words.map((w, i) => {
    let own = w.slice(start, w.length - end);
    // A bare number reads better with the word before it: "step-1", not "1".
    if (start > 0 && own.length > 0 && own.every((word) => /^\d+$/.test(word))) own = [w[start - 1], ...own];
    const base = own.join("-") || `state-${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  });
}
