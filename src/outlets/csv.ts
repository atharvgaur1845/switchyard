import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Appends one row, prefixed by its idempotency key. A row already holding the
// key is not written twice, so replaying a case after a crash is safe.
export async function appendCsv(dataDir: string, file: string, row: string[], key: string): Promise<string> {
  const path = resolve(dataDir, file);
  if (!path.startsWith(resolve(dataDir) + "/")) throw new Error(`csv path escapes the data dir: ${file}`);

  const line = [key, ...row].map(escape).join(",") + "\n";
  const existing = await readFile(path, "utf8").catch(() => "");
  if (existing.split("\n").some((l) => l.startsWith(escape(key) + ","))) {
    return `${file}: row ${key} already present`;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line);
  return `${file}: appended row ${key}`;
}

function escape(cell: string): string {
  // A leading = + - @ would make spreadsheets run the cell as a formula.
  const safe = /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
