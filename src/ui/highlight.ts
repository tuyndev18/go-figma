// Small syntax highlighter for the code view: just enough token classes to
// make generated HTML / JSX / CSS easy to scan. Returns HTML for a <pre>.
import type { CodeSection } from "../shared/messages";

/** Past this size, plain text renders faster than thousands of spans. */
const MAX_HIGHLIGHT_CHARS = 300_000;

const MARKUP =
  /(\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(<\/?)([A-Za-z][\w.:-]*)|([A-Za-z_@:][\w:.-]*)(?==)|(\/?>)|\b(export|default|function|return|const|let|import|from|true|false|null)\b|([{}])/g;

const CSS =
  /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[\w-]+)|([{}])|(#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ms|s|deg|fr)?\b)|([\w-]+)(?=\s*:(?!:))/g;

export function highlight(code: string, language: CodeSection["language"]): string {
  if (code.length > MAX_HIGHLIGHT_CHARS) return escape(code);
  return language === "CSS" ? highlightCss(code) : highlightMarkup(code);
}

function highlightMarkup(code: string): string {
  let out = "";
  let last = 0;
  for (const m of code.matchAll(MARKUP)) {
    out += escape(code.slice(last, m.index));
    const [all, comment, string, open, tag, attr, close, keyword, brace] = m;
    if (comment) out += token("comment", comment);
    else if (string) out += token("string", string);
    else if (open) out += token("punct", open) + token("tag", tag);
    else if (attr) out += token("attr", attr);
    else if (close) out += token("punct", close);
    else if (keyword) out += token("keyword", keyword);
    else if (brace) out += token("punct", brace);
    else out += escape(all);
    last = m.index + all.length;
  }
  return out + escape(code.slice(last));
}

function highlightCss(code: string): string {
  let out = "";
  let last = 0;
  let depth = 0;
  // Outside braces, plain text is a selector.
  const plain = (text: string) => (depth === 0 && text.trim() ? token("selector", text) : escape(text));
  for (const m of code.matchAll(CSS)) {
    out += plain(code.slice(last, m.index));
    const [all, comment, string, atRule, brace, number, property] = m;
    if (comment) out += token("comment", comment);
    else if (string) out += token("string", string);
    else if (atRule) out += token("keyword", atRule);
    else if (brace) {
      depth = Math.max(0, depth + (brace === "{" ? 1 : -1));
      out += token("punct", brace);
    } else if (depth === 0) out += plain(all);
    else if (number) out += token("number", number);
    else if (property) out += token("property", property);
    else out += escape(all);
    last = m.index + all.length;
  }
  return out + plain(code.slice(last));
}

/** A token may span lines (comments, template strings); close and reopen it on each line. */
function token(kind: string, text: string): string {
  return text
    .split("\n")
    .map((part) => (part ? `<span class="tok-${kind}">${escape(part)}</span>` : ""))
    .join("\n");
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
