import { describe, expect, it } from "vitest";
import { estimateTokens, formatTokens } from "../src/ui/tokens";

describe("estimateTokens", () => {
  it("counts words, numbers and punctuation as pieces", () => {
    expect(estimateTokens("")).toBe(0);
    // . | card | { | ⏎ | display | : | flex | ; | ⏎ | } (spaces join the next word)
    expect(estimateTokens(".card {\n  display: flex;\n}")).toBe(10);
    expect(estimateTokens("width: 320px;")).toBe(5);
  });

  it("counts base64 payloads by length", () => {
    const payload = "A".repeat(14_000);
    // 7 pieces before the payload, 3 for ";base64,", 14000 / 1.4, 1 for ")".
    expect(estimateTokens(`url(data:image/png;base64,${payload})`)).toBe(10_011);
  });

  it("scans megabytes of embedded image data", () => {
    const code = `<img src="data:image/jpeg;base64,${"QUJD".repeat(3_000_000)}">`;
    expect(estimateTokens(code)).toBeGreaterThan(8_000_000);
  });
});

describe("formatTokens", () => {
  it("keeps two significant digits", () => {
    expect([42, 846, 996, 1_234, 18_765, 999_400, 2_400_000].map(formatTokens)).toEqual([
      "42",
      "850",
      "1k",
      "1.2k",
      "19k",
      "999k",
      "2.4M",
    ]);
  });
});
