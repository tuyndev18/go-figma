import { describe, expect, it } from "vitest";
import { parseFigmaUrl, slugMatchesName } from "../src/shared/figmaUrl";

describe("figma links", () => {
  it("reads the file key, name and node id of a design link", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123xyz/Ecommerce-UI-Kit--Community-?node-id=125-23829&t=x1")).toEqual({
      fileKey: "AbC123xyz",
      slug: "Ecommerce-UI-Kit--Community-",
      nodeId: "125:23829",
    });
  });

  it("accepts older and other link kinds, encoded ids and links without a node", () => {
    expect(parseFigmaUrl("https://figma.com/file/KEY1/Name?node-id=12%3A34")).toEqual({ fileKey: "KEY1", slug: "Name", nodeId: "12:34" });
    expect(parseFigmaUrl("https://www.figma.com/proto/KEY2/Flow?node-id=1-2&starting-point-node-id=1%3A2")?.nodeId).toBe("1:2");
    expect(parseFigmaUrl("https://www.figma.com/board/KEY3")).toEqual({ fileKey: "KEY3" });
  });

  it("uses the branch key for branch links", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/MAIN/branch/BRANCH/Name?node-id=1-2")?.fileKey).toBe("BRANCH");
  });

  it("rejects links that aren't Figma files", () => {
    expect(parseFigmaUrl("https://example.com/design/KEY/Name")).toBeNull();
    expect(parseFigmaUrl("https://www.figma.com/community/file/123")).toBeNull();
    expect(parseFigmaUrl("12:34")).toBeNull();
  });

  it("matches URL slugs against file names", () => {
    expect(slugMatchesName("Ecommerce-UI-Kit--Community-", "Ecommerce UI Kit (Community)")).toBe(true);
    expect(slugMatchesName("Lời-mời-thi-đấu", "Lời mời thi đấu")).toBe(true);
    expect(slugMatchesName("Other-File", "Ecommerce UI Kit (Community)")).toBe(false);
  });
});
