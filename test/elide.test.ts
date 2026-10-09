import { describe, expect, it } from "vitest";
import { elideDataUris } from "../src/ui/elide";

describe("elideDataUris", () => {
  it("shortens long base64 payloads and keeps the rest of the code", () => {
    const payload = "iVBORw0KGgo".padEnd(4096, "A");
    const code = `.hero { background-image: url('data:image/png;base64,${payload}'); }`;
    expect(elideDataUris(code)).toBe(".hero { background-image: url('data:image/png;base64,iVBORw0KGgoAAAAA…(3 KB)'); }");
  });

  it("leaves short payloads and non-data base64 text alone", () => {
    const tiny = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
    expect(elideDataUris(tiny)).toBe(tiny);
    const notData = `const x = "foo;base64,${"A".repeat(100)}";`;
    expect(elideDataUris(notData)).toBe(notData);
  });

  it("handles several payloads, including ones of many megabytes (a regex overflowed the stack here)", () => {
    const big = "A".repeat(16_000_000);
    const code = `a{b:url('data:image/jpeg;base64,${big}')} c{d:url("data:image/webp;base64,${"B".repeat(200)}")}`;
    const out = elideDataUris(code);
    expect(out).toBe(`a{b:url('data:image/jpeg;base64,${"A".repeat(16)}…(11719 KB)')} c{d:url("data:image/webp;base64,${"B".repeat(16)}…(0 KB)")}`);
  });
});
