import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CodeSection } from "../shared/messages";
import { elideDataUris } from "./elide";
import { highlight } from "./highlight";

/** Must match `.gutter, .code` in styles.css. */
const LINE_HEIGHT = 18;
const PADDING_Y = 10;
/** Shorter files render whole, so the browser's own find and selection work across the file. */
const VIRTUAL_ABOVE_LINES = 1500;
/** Lines render in blocks of this many; a scroll only re-renders when it crosses a block. */
const BLOCK_LINES = 100;
/** Blocks kept rendered above and below the visible ones. */
const OVERSCAN_BLOCKS = 1;

/**
 * Line numbers are one sticky column beside the code, not a sticky marker per
 * line: thousands of sticky elements each get their own compositing layer, and
 * a long CSS file blanked the plugin window.
 *
 * Long files (a large frame makes tens of thousands of lines) only render the
 * lines in view, an infinite scroll over a full-height spacer: the highlighter
 * closes every token at the end of its line, so its output splits into lines.
 */
export function CodeView({ section }: { section: CodeSection }) {
  const { lines, widest } = useMemo(() => {
    const code = elideDataUris(section.code);
    const raw = code.split("\n");
    return {
      lines: highlight(code, section.language).split("\n"),
      // Tabs render two columns wide (tab-size: 2).
      widest: raw.reduce((max, line) => Math.max(max, line.length + (line.match(/\t/g)?.length ?? 0)), 0),
    };
  }, [section]);

  if (lines.length <= VIRTUAL_ABOVE_LINES) {
    return (
      <div className="card code-card">
        <pre className="gutter" aria-hidden="true">
          {lines.map((_, i) => i + 1).join("\n")}
        </pre>
        <pre className="code" dangerouslySetInnerHTML={{ __html: lines.join("\n") }} />
      </div>
    );
  }
  return <VirtualCode key={section.title} lines={lines} widest={widest} />;
}

function VirtualCode({ lines, widest }: { lines: string[]; widest: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const blocks = Math.ceil(lines.length / BLOCK_LINES);
  // "first-last" block range; a string so unchanged ranges don't re-render.
  const [range, setRange] = useState(`0-${Math.min(blocks - 1, OVERSCAN_BLOCKS + 1)}`);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const blockHeight = BLOCK_LINES * LINE_HEIGHT;
        const top = Math.max(0, el.scrollTop - PADDING_Y);
        const first = Math.max(0, Math.floor(top / blockHeight) - OVERSCAN_BLOCKS);
        const last = Math.min(blocks - 1, Math.floor((top + el.clientHeight) / blockHeight) + OVERSCAN_BLOCKS);
        setRange(`${first}-${last}`);
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [blocks]);

  const [first, last] = range.split("-").map(Number);
  const start = first * BLOCK_LINES;
  const end = Math.min(lines.length, (last + 1) * BLOCK_LINES);
  const height = lines.length * LINE_HEIGHT + 2 * PADDING_Y;
  const shift = { display: "block", transform: `translateY(${start * LINE_HEIGHT}px)` } as const;
  const numbers = [];
  for (let i = start; i < end; i++) numbers.push(i + 1);

  return (
    <div className="card code-card" ref={ref}>
      <pre className="gutter" aria-hidden="true" style={{ height, minWidth: `calc(${String(lines.length).length}ch + 18px)` }}>
        <span style={shift}>{numbers.join("\n")}</span>
      </pre>
      <pre className="code" style={{ height, minWidth: `calc(${widest}ch + 28px)` }}>
        <span style={shift} dangerouslySetInnerHTML={{ __html: lines.slice(start, end).join("\n") }} />
      </pre>
    </div>
  );
}
