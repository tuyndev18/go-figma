// Turns plugin results into text written for AI agents: what each part is and
// how to use it, in the spirit of Figma's own MCP server.
import type { DesignContextResult, StyleDef, VariableCollectionInfo, VariableDef, VariableValue } from "../src/shared/bridge";
import type { CodeSection } from "../src/shared/messages";
import { TARGETS, type Target } from "../src/shared/settings";

export function fence(section: CodeSection, target: Target): string {
  if (section.language === "JAVASCRIPT") return target === "react-tailwind" ? "jsx" : "js";
  return section.language.toLowerCase();
}

export const codeBlock = (section: CodeSection, target: Target) =>
  `\`\`\`${fence(section, target)}\n${section.code}\n\`\`\``;

const targetLabel = (target: Target) => TARGETS.find((t) => t.value === target)?.label ?? target;

const GUIDE = (format: Target) => `## How to use this
This is REFERENCE code generated from the Figma layer tree (${targetLabel(format)}), not final code.
- Convert it to the target project's stack, styling system and conventions. Don't add Tailwind or other dependencies the project doesn't use.
- Hints, strongest first:
  1. \`data-component\` / \`data-props\`: the layer is an instance of a design-system component. Use the project's matching component with these props instead of rebuilding its markup; its children in the reference code only show how it looks.
  2. Component descriptions and documentation links (below): follow them.
  3. \`data-annotation\`: notes from the designer; follow them.
  4. \`var(--token, fallback)\`: design tokens. Map them to the project's tokens (see "Design tokens").
  5. Raw hex colors and absolute positions are loosely structured; use the screenshot to infer intent and prefer flex/grid layouts.
- \`data-node-id\` / \`data-name\` identify Figma layers. Drop them from the final code; pass ids as nodeIds to zoom into a part.
- Images and icons are real exported files (see "Assets"). Copy them into the project and reference them; never redraw icons or invent SVG paths.
- Name components and props after what they are, and turn sample text into props or data where it is clearly dynamic.
- Check the result against the screenshot.`;

export function designContextText(result: DesignContextResult, assets: { ref: string; path: string; detail: string }[], savedCode: string[]): string {
  const title = result.nodes.map((n) => `"${n.name}" (${n.id})`).join(", ");
  const parts: string[] = [`# Design context: ${title}`];

  if (result.tooLarge) {
    parts.push(
      `The reference code is ${result.codeChars.toLocaleString("en")} characters, too much to use in one go. ` +
        "Implement it section by section: call get_design_context with nodeIds of one or a few sections from the outline below. " +
        `The full code was saved for reference:\n${savedCode.map((p) => `- ${p}`).join("\n")}`,
      `## Outline\n\`\`\`xml\n${result.metadata ?? ""}\n\`\`\``,
    );
  } else {
    parts.push(`## Reference code\n\n${result.sections.map((s) => codeBlock(s, result.format)).join("\n\n")}`);
  }

  parts.push(GUIDE(result.format));

  if (result.components.length > 0) {
    const lines = result.components.map((c) => {
      const facts = [
        c.definition ? "main component" : `${c.instances} instance${c.instances === 1 ? "" : "s"}`,
        c.remote ? "from a team library" : "",
        c.variants.length > 0 ? `variants used: ${c.variants.map((v) => `{${v}}`).join(" ")}` : "",
        `e.g. data-node-id ${c.nodeIds.slice(0, 3).join(", ")}`,
      ].filter(Boolean);
      let line = `- **${c.name}**: ${facts.join("; ")}`;
      if (c.description) line += `\n  Description: ${c.description.replace(/\s*\n\s*/g, " ")}`;
      if (c.documentationLinks) line += `\n  Docs: ${c.documentationLinks.join(", ")}`;
      return line;
    });
    parts.push(`## Components\nLook for these in the codebase before writing new ones.\n${lines.join("\n")}`);
  }

  const tokens = tokensText(result.variables, result.styles);
  if (tokens) parts.push(`## Design tokens\n${tokens}`);

  if (result.annotations.length > 0) {
    parts.push(`## Annotations\n${result.annotations.map((a) => `- "${a.name}" (${a.nodeId}): ${a.text}`).join("\n")}`);
  }

  if (assets.length > 0) {
    const lines = assets.map((a) => `- \`${a.ref}\` → ${a.path} (${a.detail})`);
    parts.push(`## Assets\nThe code references these paths; the files are already on disk:\n${lines.join("\n")}`);
  }

  if (result.warnings.length > 0) parts.push(`## Conversion warnings\n${result.warnings.map((w) => `- ${w}`).join("\n")}`);
  if (result.screenshots.length > 0) parts.push("## Screenshot\nAttached below: the design as rendered in Figma.");
  return parts.join("\n\n");
}

export function tokensText(variables: VariableDef[], styles: StyleDef[]): string {
  const lines: string[] = [];
  for (const v of variables) {
    lines.push(`- \`--${v.cssName}\`: ${valueText(v.value)}  (${[v.collection, v.name].filter(Boolean).join(" / ")}, ${v.type.toLowerCase()})`);
  }
  for (const s of styles) lines.push(`- ${s.type.toLowerCase()} style "${s.name}": ${s.value}`);
  return lines.join("\n");
}

const valueText = (value: VariableValue) => (typeof value === "object" ? `var(--${value.alias})` : String(value));

export function rootCss(collections: VariableCollectionInfo[]): string {
  const lines = collections.flatMap((collection) =>
    collection.variables
      .filter((v) => v.type === "COLOR")
      .map((v) => `  --${v.cssName}: ${valueText(v.values[collection.modes[0]])}; /* ${collection.name}: ${v.name} */`),
  );
  return `:root {\n${lines.join("\n")}\n}`;
}

export function tooLargeText(size: number, saved: string[], hint: string): string {
  return [`The output is ${size.toLocaleString("en")} characters, too large to return inline. Saved to:`, ...saved, "", hint].join("\n");
}
