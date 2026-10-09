// A rough token count for generated code, so users can tell how much of an AI
// agent's context a selection takes. Real tokenizers (and Claude's) aren't
// available offline; this counts the pieces a BPE tokenizer splits code into.
// Tuned against cl100k_base on generated HTML, CSS, Tailwind, React and prose:
// within ~15% of it, erring high. Other models' tokenizers differ further.

import { isBase64 } from "./elide";

const BASE64_MARK = ";base64,";

type Kind = "letters" | "digits" | "space" | "nonAscii" | "symbols";

/** Characters per token for each kind of run. */
const PER_TOKEN = { letters: 8, digits: 3, symbols: 2, nonAscii: 1.3, base64: 1.4 };

function kindOf(c: number): Kind {
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return "letters";
  if (c >= 48 && c <= 57) return "digits";
  if (c === 32 || c === 9 || c === 10 || c === 13) return "space";
  if (c > 127) return "nonAscii";
  return "symbols";
}

/** A linear scan, no regex: code with embedded images can be megabytes long (see elide.ts). */
export function estimateTokens(code: string): number {
  let tokens = 0;
  let i = 0;
  while (i < code.length) {
    // Base64 payloads tokenize far worse than code, and dominate when present.
    if (code.startsWith(BASE64_MARK, i)) {
      i += BASE64_MARK.length;
      const start = i;
      while (i < code.length && isBase64(code.charCodeAt(i))) i++;
      tokens += 3 + (i - start) / PER_TOKEN.base64;
      continue;
    }
    const kind = kindOf(code.charCodeAt(i));
    const start = i;
    let newline = false;
    do {
      newline ||= code.charCodeAt(i) === 10;
      i++;
    } while (i < code.length && kindOf(code.charCodeAt(i)) === kind && !(kind === "symbols" && code.startsWith(BASE64_MARK, i)));
    const length = i - start;
    // Spaces merge into the next word; a line break and its indent are one token.
    if (kind === "space") tokens += newline ? 1 : 0;
    // Accented letters split into byte pieces rather than whole words.
    else if (kind === "nonAscii") tokens += length / PER_TOKEN.nonAscii;
    else tokens += Math.ceil(length / PER_TOKEN[kind]);
  }
  return Math.round(tokens);
}

/** Two significant digits at most: the estimate isn't more precise than that. */
export function formatTokens(tokens: number): string {
  if (tokens < 995) return String(tokens < 100 ? tokens : Math.round(tokens / 10) * 10);
  if (tokens < 999_500) return `${round2(tokens / 1000)}k`;
  return `${round2(tokens / 1_000_000)}M`;
}

function round2(value: number): string {
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}
