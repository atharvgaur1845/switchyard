import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGRAMS, SECTIONS } from "../src/web/static/about.js";

// The About page and the README explain the system with the same diagrams.
// about.js is their single source; the README's copy must not drift.
describe("the About page and the README", () => {
  const readme = readFileSync("README.md", "utf8");

  it("carry every diagram, word for word", () => {
    for (const [name, source] of Object.entries(DIAGRAMS)) {
      expect(readme.includes("```mermaid\n" + source + "\n```"), `diagram "${name}" differs or is missing in README.md`).toBe(true);
    }
  });

  it("carry every section, in order", () => {
    const titles = [...readme.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1]);
    expect(titles).toEqual(SECTIONS.map((s) => s.title));
  });

  it("draw only diagrams that exist", () => {
    for (const s of SECTIONS) if (s.diagram) expect(DIAGRAMS).toHaveProperty(s.diagram);
  });
});
