// Design tokens: the variables and styles a selection uses (like Figma's MCP
// get_variable_defs), or every local variable of the file.
import { rawCssColor, variableToCssName } from "../core/color";
import { remote } from "../core/remote";
import type { StyleDef, VariableCollectionInfo, VariableDef, VariableValue as BridgeValue } from "../shared/bridge";

const STYLE_KEYS = ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId"] as const;

/** Variables bound anywhere in the layers (resolved in the layer's mode) and the styles applied. */
export async function usedTokens(nodes: readonly SceneNode[]): Promise<{ variables: VariableDef[]; styles: StyleDef[] }> {
  const consumers = new Map<string, SceneNode>();
  const styleIds = new Set<string>();

  const visit = (node: SceneNode) => {
    if (!node.visible) return;
    const bind = (value: unknown) => {
      for (const id of aliasIds(value)) if (!consumers.has(id)) consumers.set(id, node);
    };
    if ("boundVariables" in node) bind(node.boundVariables);
    // Paints and effects carry their own bindings.
    for (const key of ["fills", "strokes", "effects"] as const) {
      const list = key in node ? (node as unknown as Record<string, unknown>)[key] : undefined;
      if (Array.isArray(list)) for (const item of list) bind((item as { boundVariables?: unknown }).boundVariables);
    }
    for (const key of STYLE_KEYS) {
      const id = key in node ? (node as unknown as Record<string, unknown>)[key] : undefined;
      if (typeof id === "string" && id !== "") styleIds.add(id);
    }
    if (node.type === "TEXT") {
      // Mixed text styles and per-range bindings only show up on segments.
      for (const segment of node.getStyledTextSegments(["textStyleId", "fillStyleId", "boundVariables", "fills"])) {
        if (segment.textStyleId) styleIds.add(segment.textStyleId);
        if (segment.fillStyleId) styleIds.add(segment.fillStyleId);
        bind(segment.boundVariables);
        for (const fill of segment.fills) if ("boundVariables" in fill) bind(fill.boundVariables);
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  nodes.forEach(visit);

  const variables: VariableDef[] = [];
  const aliasName = aliasNamer();
  const collections = new Map<string, string>();
  for (const [id, consumer] of consumers) {
    const variable = await remote(() => figma.variables.getVariableByIdAsync(id), null);
    if (!variable) continue;
    if (!collections.has(variable.variableCollectionId)) {
      const collection = await remote(() => figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId), null);
      collections.set(variable.variableCollectionId, collection?.name ?? "");
    }
    let value: BridgeValue;
    try {
      value = await toBridgeValue(variable.resolveForConsumer(consumer).value, aliasName);
    } catch {
      const first = Object.values(variable.valuesByMode)[0];
      value = first === undefined ? "" : await toBridgeValue(first, aliasName);
    }
    variables.push({
      name: variable.name,
      cssName: variableToCssName(variable.name),
      collection: collections.get(variable.variableCollectionId) ?? "",
      type: variable.resolvedType,
      value,
    });
  }

  const styles: StyleDef[] = [];
  for (const id of styleIds) {
    const style = await remote(() => figma.getStyleByIdAsync(id), null);
    if (style) styles.push({ type: style.type, name: style.name, value: describeStyle(style) });
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { variables: variables.sort(byName), styles: styles.sort(byName) };
}

/** Every local variable, per collection and mode. */
export async function localVariables(): Promise<VariableCollectionInfo[]> {
  const aliasName = aliasNamer();
  const collections: VariableCollectionInfo[] = [];
  for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
    const info: VariableCollectionInfo = { name: collection.name, modes: collection.modes.map((m) => m.name), variables: [] };
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      const values: Record<string, BridgeValue> = {};
      for (const mode of collection.modes) {
        const value = variable.valuesByMode[mode.modeId];
        if (value !== undefined) values[mode.name] = await toBridgeValue(value, aliasName);
      }
      info.variables.push({ name: variable.name, cssName: variableToCssName(variable.name), type: variable.resolvedType, values });
    }
    collections.push(info);
  }
  return collections;
}

function aliasNamer(): (id: string) => Promise<string> {
  const names = new Map<string, string>();
  return async (id) => {
    if (!names.has(id)) {
      const variable = await remote(() => figma.variables.getVariableByIdAsync(id), null);
      names.set(id, variable ? variableToCssName(variable.name) : id);
    }
    return names.get(id)!;
  };
}

async function toBridgeValue(value: VariableValue, aliasName: (id: string) => Promise<string>): Promise<BridgeValue> {
  if (typeof value !== "object") return value;
  if ("type" in value && value.type === "VARIABLE_ALIAS") return { alias: await aliasName(value.id) };
  if ("r" in value) return rawCssColor({ r: value.r, g: value.g, b: value.b, a: "a" in value ? value.a : 1 });
  return JSON.stringify(value);
}

/** Variable ids in a `boundVariables` structure (aliases, arrays of them, or objects of either). */
function aliasIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(aliasIds);
  const record = value as Record<string, unknown>;
  if (record.type === "VARIABLE_ALIAS" && typeof record.id === "string") return [record.id];
  return Object.values(record).flatMap(aliasIds);
}

function describeStyle(style: BaseStyle): string {
  switch (style.type) {
    case "PAINT":
      return style.paints.map(describePaint).join(", ");
    case "TEXT": {
      const { fontName, fontSize, lineHeight, letterSpacing } = style;
      const parts = [`${fontName.family} ${fontName.style}`, `${fontSize}px`];
      if (lineHeight.unit !== "AUTO") parts.push(`line-height ${lineHeight.value}${lineHeight.unit === "PIXELS" ? "px" : "%"}`);
      if (letterSpacing.value !== 0) parts.push(`letter-spacing ${letterSpacing.value}${letterSpacing.unit === "PIXELS" ? "px" : "%"}`);
      return parts.join(", ");
    }
    case "EFFECT":
      return style.effects
        .map((e) =>
          e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"
            ? `${e.type === "INNER_SHADOW" ? "inset " : ""}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread ?? 0}px ${rawCssColor(e.color)}`
            : `${e.type.toLowerCase().replace(/_/g, " ")}${"radius" in e ? ` ${e.radius}px` : ""}`,
        )
        .join(", ");
    default:
      return style.type.toLowerCase();
  }
}

function describePaint(paint: Paint): string {
  if (paint.type === "SOLID") return rawCssColor({ ...paint.color, a: paint.opacity ?? 1 });
  if (paint.type === "IMAGE") return "image";
  if ("gradientStops" in paint) {
    const stops = paint.gradientStops.map((s) => rawCssColor(s.color)).join(" → ");
    return `${paint.type.toLowerCase().replace(/_/g, " ")} (${stops})`;
  }
  return paint.type.toLowerCase();
}
