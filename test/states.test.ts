import { describe, expect, it } from "vitest";
import type { FrameNode, IRNode } from "../src/core/ir";
import { defaultStateNames, guessBreakpoints } from "../src/core/pageTags";
import { Warnings } from "../src/core/warnings";
import { generate } from "../src/generators";
import { buildProject } from "../src/generators/project";
import { pageGroups, pageName } from "../src/generators/responsive";
import { BLUE, frame, segment, shape, text } from "./fixtures";

const screen = (state: string, overrides: Partial<FrameNode>): FrameNode =>
  frame({ name: `Login ${state[0].toUpperCase()}${state.slice(1)}`, state, box: { x: 0, y: 0, width: 375, height: 800, rotation: 0 }, ...overrides });

const button = (fill?: boolean) => shape({ name: "Button", fills: fill ? [{ type: "solid", color: BLUE }] : [] });
const alert = text([segment({ text: "Wrong password" })], { name: "Alert" });

const out = (roots: IRNode[], target: "html-css" | "react-tailwind" | "html-tailwind") =>
  generate(roots, [], { target }, new Warnings()).sections;

describe("pages with states", () => {
  const idle = screen("default", { children: [button()] });
  const error = screen("error", { children: [alert, button(true)] });

  it("writes the markup once, with the default state as the base and the others keyed on data-state", () => {
    const [html, css] = out([idle, error], "html-css");
    expect(html.code).toContain('<div class="login" data-state="default">');
    expect(html.code.match(/class="button"/g)).toHaveLength(1);
    expect(css.code).toMatch(/\.alert \{[^}]*display: none;/);
    expect(css.code).toContain("/* State: error */");
    expect(css.code).toMatch(/\.login\[data-state="error"\] \.alert \{\n {2}display: block;\n\}/);
    expect(css.code).toMatch(/\.login\[data-state="error"\] \.button \{\n {2}background-color: #0d99ff;\n\}/);
    // Frames keep their size: states are not breakpoints.
    expect(css.code).not.toContain("@media");
    expect(css.code).toMatch(/\.login \{[^}]*width: 375px;/);
  });

  it("overrides each state against the default, not against the previous state", () => {
    const success = screen("success", { children: [button()] });
    const [, css] = out([idle, error, success], "html-css");
    expect(css.code).not.toContain("/* State: success */");
  });

  it("takes the state from a prop in React and switches with group-data variants", () => {
    const [react] = out([idle, error], "react-tailwind");
    expect(react.code).toContain('/** @param {{ state?: "default" | "error" }} props */');
    expect(react.code).toContain('export default function Login({ state = "default" }) {');
    expect(react.code).toContain('className="group w-[375px] h-200" data-state={state}');
    expect(react.code).toMatch(/className="[^"]*hidden[^"]*group-data-\[state=error\]:block"/);
    expect(react.code).toContain("group-data-[state=error]:bg-[#0d99ff]");

    const [html] = out([idle, error], "html-tailwind");
    expect(html.code).toContain('data-state="default"');
  });

  it("styles the root itself with data-[state=…] variants", () => {
    const tall = screen("error", { box: { x: 0, y: 0, width: 375, height: 900, rotation: 0 } });
    const [react] = out([screen("default", {}), tall], "react-tailwind");
    expect(react.code).toContain("data-[state=error]:h-225");
    const [, css] = out([screen("default", {}), tall], "html-css");
    expect(css.code).toContain('.login[data-state="error"] {\n  height: 900px;\n}');
  });

  it("previews each state, the default first", () => {
    const result = generate([idle, error], [], { target: "html-css" }, new Warnings());
    expect(result.previewSizes?.map((s) => [s.label, s.state, s.width])).toEqual([
      ["default", "default", 375],
      ["error", "error", 375],
    ]);
  });

  it("groups frames with states into one page in selection order and keeps duplicates separate", () => {
    const warnings = new Warnings();
    const other = frame({ name: "Home" });
    const again = screen("error", { name: "Login Error Copy" });
    const groups = pageGroups([other, error, idle, again], warnings);
    expect(groups.map((g) => g.map((r) => r.name))).toEqual([["Home"], ["Login Error", "Login Default"], ["Login Error Copy"]]);
    expect(pageName(groups[1])).toBe("Login");
    expect(warnings.list()[0]).toContain('"Login Error Copy" is exported as a separate page');
  });

  it("names the page after the words its frames share", () => {
    const step = (n: number) => frame({ name: `Checkout ${n}`, state: `step-${n}` });
    expect(pageName([step(1), step(2)])).toBe("Checkout");
    expect(pageName([frame({ name: "Default Login" }), frame({ name: "Error Login" })])).toBe("Login");
  });

  it("switches state with ?state= in exported projects", () => {
    const next = buildProject([idle, error], [], "react-tailwind", new Warnings());
    const page = next.files.find((f) => f.path === "app/page.jsx")?.text;
    expect(page).toContain("export default async function Login({ searchParams }) {");
    expect(page).toContain('const { state = "default" } = await searchParams;');
    expect(next.files.find((f) => f.path === "README.md")?.text).toContain("states: default, `/?state=error`");

    const site = buildProject([idle, error], [], "html-css", new Warnings());
    const index = site.files.find((f) => f.path === "index.html")?.text;
    expect(index).toContain('document.querySelector("[data-state]").dataset.state = state;');
    expect(site.files.find((f) => f.path === "README.md")?.text).toContain("states: default, `index.html?state=error`");
  });
});

describe("default page tags", () => {
  it("names states after what sets each frame name apart", () => {
    expect(defaultStateNames(["Login Default", "Login Error"])).toEqual(["default", "error"]);
    expect(defaultStateNames(["Checkout - Step 1", "Checkout - Step 2"])).toEqual(["step-1", "step-2"]);
    // "Cart" has no word to spare, so nothing is shared.
    expect(defaultStateNames(["Cart empty", "Cart full", "Cart"])).toEqual(["cart-empty", "cart-full", "cart"]);
    expect(defaultStateNames(["Đăng nhập", "Đăng nhập"])).toEqual(["nhap", "nhap-2"]);
    expect(defaultStateNames(["!!", "Frame"])).toEqual(["state-1", "frame"]);
  });

  it("guesses breakpoints from names, else widths, once per tier", () => {
    const frames = [
      { name: "Tablet Landing", width: 768 },
      { name: "Mobile landing", width: 375 },
      { name: "Landing Desktop", width: 1440 },
      { name: "Landing wide", width: 1920 },
    ];
    expect(guessBreakpoints(frames)).toEqual(["tablet", "mobile", "desktop", undefined]);
    expect(guessBreakpoints([{ name: "A", width: 390 }, { name: "B", width: 820 }])).toEqual(["mobile", "tablet"]);
  });
});
