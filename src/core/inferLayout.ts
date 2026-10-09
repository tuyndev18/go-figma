// Layout inference: turns frames without auto layout (absolutely placed
// children) into nested flex rows/columns, so generated code flows like a
// hand-written page instead of pinning every layer to x/y coordinates.
//
// 1. Containment: a shape or plain frame that fully contains layers drawn on
//    top of it becomes their container ("background box" → wrapper div).
// 2. XY-cut: children are split into bands that don't overlap vertically
//    (→ column); each band is split horizontally (→ row); recursively.
// 3. Gaps, padding and alignment are measured from the geometry; irregular
//    spacing becomes per-child margins. Only truly overlapping layers stay
//    absolutely positioned, inside the smallest wrapper that holds them.
import type { AutoLayout, Box, FrameNode, IRNode, Sides } from "./ir";

const EPS = 1; // px tolerance for "touching", "aligned" and "contained"

export function inferLayout(node: IRNode): IRNode {
  return node.kind === "frame" ? inferFrame(node) : node;
}

function inferFrame(frame: FrameNode): FrameNode {
  if (frame.layout) return { ...frame, children: frame.children.map(inferLayout) };

  const children = nestIntoContainers(frame.children).map(inferLayout);
  if (children.length === 0 || children.some((c) => c.positioning !== "absolute" || c.box.rotation !== 0)) {
    return { ...frame, children };
  }

  const tree = partition(children);
  if (tree.kind === "overlap") return { ...frame, children };

  const items = tree.kind === "leaf" ? [tree] : tree.items;
  const direction = tree.kind === "stack" ? tree.direction : "column";
  const flow = items.map((item) => materialize(item));
  const { layout, children: placed } = measure(direction, flow, { width: frame.box.width, height: frame.box.height });
  return { ...frame, layout, children: placed };
}

// ---------------------------------------------------------------------------
// 1. Containment

const area = (b: Box) => b.width * b.height;

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

const canContain = (n: IRNode) =>
  n.box.rotation === 0 && !n.box.flip && (n.kind === "shape" || (n.kind === "frame" && n.layout === null));

/** Re-parent each layer under the smallest container below it that fully encloses it. */
function nestIntoContainers(nodes: IRNode[]): IRNode[] {
  const parentOf = new Map<number, number>();
  nodes.forEach((child, i) => {
    if (child.positioning !== "absolute" || child.box.rotation !== 0) return;
    let best = -1;
    for (let j = 0; j < i; j++) {
      const candidate = nodes[j];
      if (!canContain(candidate) || candidate.positioning !== "absolute") continue;
      if (area(candidate.box) <= area(child.box) || !contains(candidate.box, child.box)) continue;
      if (best === -1 || area(candidate.box) < area(nodes[best].box)) best = j;
    }
    if (best !== -1) parentOf.set(i, best);
  });
  if (parentOf.size === 0) return nodes;

  const build = (index: number): IRNode => {
    const node = nodes[index];
    const kids = nodes
      .map((_, i) => i)
      .filter((i) => parentOf.get(i) === index)
      .map((i) => shift(build(i), -node.box.x, -node.box.y));
    if (kids.length === 0) return node;
    const existing = node.kind === "frame" ? node.children : [];
    return {
      ...node,
      kind: "frame",
      layout: null,
      strokesIncludedInLayout: false,
      clipsContent: node.kind === "frame" ? node.clipsContent : false,
      children: [...existing, ...kids],
    } as FrameNode;
  };

  return nodes.map((_, i) => i).filter((i) => !parentOf.has(i)).map(build);
}

const shift = (node: IRNode, dx: number, dy: number): IRNode => ({
  ...node,
  box: { ...node.box, x: node.box.x + dx, y: node.box.y + dy },
});

// ---------------------------------------------------------------------------
// 2. XY-cut

type Tree =
  | { kind: "leaf"; node: IRNode }
  | { kind: "stack"; direction: "row" | "column"; items: Tree[] }
  | { kind: "overlap"; nodes: IRNode[] };

function partition(nodes: IRNode[]): Tree {
  if (nodes.length === 1) return { kind: "leaf", node: nodes[0] };
  const rows = bands(nodes, "y");
  if (rows) return { kind: "stack", direction: "column", items: rows.map(partition) };
  const columns = bands(nodes, "x");
  if (columns) return { kind: "stack", direction: "row", items: columns.map(partition) };
  return { kind: "overlap", nodes };
}

/** Group nodes into bands separated by empty space along an axis; null if only one band. */
function bands(nodes: IRNode[], axis: "x" | "y"): IRNode[][] | null {
  const start = (n: IRNode) => (axis === "x" ? n.box.x : n.box.y);
  const end = (n: IRNode) => start(n) + (axis === "x" ? n.box.width : n.box.height);
  const sorted = [...nodes].sort((a, b) => start(a) - start(b));

  const result: IRNode[][] = [];
  let bandEnd = -Infinity;
  for (const node of sorted) {
    if (result.length === 0 || start(node) >= bandEnd - EPS) {
      result.push([node]);
      bandEnd = end(node);
    } else {
      result[result.length - 1].push(node);
      bandEnd = Math.max(bandEnd, end(node));
    }
  }
  if (result.length < 2) return null;
  // Keep the original paint order inside each band.
  return result.map((band) => band.sort((a, b) => nodes.indexOf(a) - nodes.indexOf(b)));
}

// ---------------------------------------------------------------------------
// 3. Materialize the tree as IR wrappers with measured layout

function bbox(nodes: IRNode[]): Box {
  const x = Math.min(...nodes.map((n) => n.box.x));
  const y = Math.min(...nodes.map((n) => n.box.y));
  const right = Math.max(...nodes.map((n) => n.box.x + n.box.width));
  const bottom = Math.max(...nodes.map((n) => n.box.y + n.box.height));
  return { x, y, width: right - x, height: bottom - y, rotation: 0 };
}

function wrapper(name: string, box: Box, children: IRNode[], layout: AutoLayout | null): FrameNode {
  return {
    id: "",
    name,
    kind: "frame",
    box,
    sizing: layout ? { horizontal: "hug", vertical: "hug" } : { horizontal: "fixed", vertical: "fixed" },
    positioning: "absolute",
    opacity: 1,
    fills: [],
    strokes: [],
    effects: [],
    radius: [0, 0, 0, 0],
    layout,
    strokesIncludedInLayout: false,
    clipsContent: false,
    children,
  };
}

/** Turn a partition tree into one IR node positioned in its parent's coordinates. */
function materialize(tree: Tree): IRNode {
  switch (tree.kind) {
    case "leaf":
      return tree.node;
    case "overlap": {
      // Genuinely overlapping layers: keep them absolute inside a tight box.
      const box = bbox(tree.nodes);
      return wrapper("Group", box, tree.nodes.map((n) => shift(n, -box.x, -box.y)), null);
    }
    case "stack": {
      const children = tree.items.map(materialize);
      const box = bbox(children);
      const local = children.map((c) => shift(c, -box.x, -box.y));
      const { layout, children: placed } = measure(tree.direction, local, null);
      return wrapper(tree.direction === "row" ? "Row" : "Column", box, placed, layout);
    }
  }
}

/**
 * Derive auto layout values for children already ordered along `direction`,
 * with boxes relative to the container. `size` is the container's fixed size,
 * or null for wrappers that hug their content.
 */
function measure(
  direction: "row" | "column",
  children: IRNode[],
  size: { width: number; height: number } | null,
): { layout: AutoLayout; children: IRNode[] } {
  const row = direction === "row";
  const mainStart = (n: IRNode) => (row ? n.box.x : n.box.y);
  const mainSize = (n: IRNode) => (row ? n.box.width : n.box.height);
  const crossStart = (n: IRNode) => (row ? n.box.y : n.box.x);
  const crossSize = (n: IRNode) => (row ? n.box.height : n.box.width);

  // Main axis: the most common gap becomes `gap`, deviations become margins.
  const gaps = children.slice(1).map((n, i) => mainStart(n) - (mainStart(children[i]) + mainSize(children[i])));
  const gap = Math.max(0, mostCommon(gaps.map(round)) ?? 0);

  const padMainStart = Math.max(0, round(mainStart(children[0])));
  const lastEnd = mainStart(children[children.length - 1]) + mainSize(children[children.length - 1]);
  const containerMain = size ? (row ? size.width : size.height) : lastEnd;
  const padMainEnd = size ? Math.max(0, round(containerMain - lastEnd)) : 0;

  // Cross axis: find a common alignment, otherwise align to start with margins.
  const padCrossStart = Math.max(0, round(Math.min(...children.map(crossStart))));
  const containerCross = size ? (row ? size.height : size.width) : Math.max(...children.map((n) => crossStart(n) + crossSize(n)));
  const maxCrossEnd = Math.max(...children.map((n) => crossStart(n) + crossSize(n)));
  const padCrossEnd = size ? Math.max(0, round(containerCross - maxCrossEnd)) : 0;
  const innerStart = padCrossStart;
  const innerEnd = containerCross - padCrossEnd;
  const near = (a: number, b: number) => Math.abs(a - b) <= EPS;

  let align: AutoLayout["align"] = "start";
  if (children.every((n) => near(crossStart(n), innerStart))) align = "start";
  else if (children.every((n) => near(crossStart(n) + crossSize(n) / 2, (innerStart + innerEnd) / 2))) align = "center";
  else if (children.every((n) => near(crossStart(n) + crossSize(n), innerEnd))) align = "end";

  const placed = children.map((child, i): IRNode => {
    const mainOffset = i === 0 ? 0 : round(gaps[i - 1]) - gap;
    const crossOffset = align === "start" ? round(crossStart(child) - innerStart) : 0;
    const margin = row ? { top: crossOffset, left: mainOffset } : { top: mainOffset, left: crossOffset };
    return {
      ...child,
      positioning: "flow",
      ...(margin.top !== 0 || margin.left !== 0 ? { margin } : {}),
    };
  });

  const padding: Sides = row
    ? { top: padCrossStart, right: padMainEnd, bottom: padCrossEnd, left: padMainStart }
    : { top: padMainStart, right: padCrossEnd, bottom: padMainEnd, left: padCrossStart };

  return {
    layout: { direction, gap, crossGap: 0, wrap: false, justify: "start", align, padding },
    children: placed,
  };
}

const round = (n: number) => Math.round(n);

function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  for (const [value, count] of counts) {
    if (best === undefined || count > counts.get(best)! || (count === counts.get(best)! && value < best)) best = value;
  }
  return best;
}
