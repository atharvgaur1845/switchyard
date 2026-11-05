import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCsv } from "../src/outlets/csv.ts";

describe("csv outlet", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-csv-"));

  it("appends once per key, escaping cells and spreadsheet formulas", async () => {
    await appendCsv(dir, "ledger.csv", ["Asha, R", "=HYPERLINK(x)"], "c1/record");
    const again = await appendCsv(dir, "ledger.csv", ["Asha, R", "=HYPERLINK(x)"], "c1/record");
    expect(again).toMatch(/already present/);
    expect(readFileSync(join(dir, "ledger.csv"), "utf8")).toBe(`c1/record,"Asha, R",'=HYPERLINK(x)\n`);
  });

  it("refuses paths outside the data dir", async () => {
    await expect(appendCsv(dir, "../evil.csv", [], "k")).rejects.toThrow(/escapes/);
  });
});
