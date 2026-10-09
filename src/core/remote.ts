// Figma loads library components, variables, styles and image bytes over the
// network, and can wait a long time (or forever) when it is offline. Guard
// those lookups with a timeout, and after one failure skip that kind of lookup
// for a while, so an outage costs seconds per run instead of hanging it.

const BACKOFF_MS = 60_000;

/** "library": components, variables, styles. "image": image bytes. */
export type RemoteKind = "library" | "image";

const TIMEOUT_MS: Record<RemoteKind, number> = { library: 4000, image: 15_000 };
const offlineUntil: Record<RemoteKind, number> = { library: 0, image: 0 };
const failures: Record<RemoteKind, number> = { library: 0, image: 0 };

/** Run a lookup that may hit the network; on failure or timeout return `fallback`. */
export async function remote<T>(load: () => Promise<T>, fallback: T, kind: RemoteKind = "library"): Promise<T> {
  if (Date.now() < offlineUntil[kind]) {
    failures[kind]++;
    return fallback;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), TIMEOUT_MS[kind])));
  try {
    const result = await Promise.race([load(), timeout]);
    if (result !== TIMED_OUT) return result as T;
    offlineUntil[kind] = Date.now() + BACKOFF_MS;
  } catch (error) {
    // Missing nodes etc. are ordinary; only connection problems pause lookups.
    if (/connect|network|internet|timed? ?out/i.test(String(error))) offlineUntil[kind] = Date.now() + BACKOFF_MS;
  } finally {
    clearTimeout(timer);
  }
  failures[kind]++;
  return fallback;
}

const TIMED_OUT = Symbol("timed out");

/** Warnings for lookups that fell back since the last call. */
export function takeRemoteWarnings(): string[] {
  const warnings: string[] = [];
  if (failures.library > 0) {
    warnings.push(
      "Some library components, variables or styles could not be loaded (Figma could not reach its servers); their names may fall back to layer names.",
    );
  }
  if (failures.image > 0) warnings.push("Some images could not be downloaded from Figma and were left out.");
  failures.library = 0;
  failures.image = 0;
  return warnings;
}
