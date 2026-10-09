// Embedded images make generated code megabytes long; the code view shows a
// stub for each base64 payload instead (Copy still copies everything).

const MARK = ";base64,";
/** Shorter payloads (tiny icons) are left as they are. */
const MIN_ELIDED = 64;
const KEPT = 16;
const DATA_PREFIX = /data:[\w/+.-]+$/;

/**
 * A linear scan rather than a regex: V8 keeps a backtrack entry per character
 * of `[A-Za-z0-9+/=]{64,}`, and a 12 MB photo overflowed it ("Maximum call
 * stack size exceeded"), which blanked the code view.
 */
export function elideDataUris(code: string): string {
  let out = "";
  let from = 0;
  for (let at = code.indexOf(MARK); at !== -1; at = code.indexOf(MARK, from)) {
    const start = at + MARK.length;
    let end = start;
    while (end < code.length && isBase64(code.charCodeAt(end))) end++;
    // Only `data:<mime>;base64,` payloads; the prefix is short, so test a small window.
    if (end - start < MIN_ELIDED || !DATA_PREFIX.test(code.slice(Math.max(from, at - 100), at))) {
      out += code.slice(from, start);
      from = start;
      continue;
    }
    const kb = Math.round(((end - start) * 3) / 4 / 1024);
    out += `${code.slice(from, start + KEPT)}…(${kb} KB)`;
    from = end;
  }
  return out + code.slice(from);
}

function isBase64(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 43 || // +
    c === 47 || // /
    c === 61 // =
  );
}
