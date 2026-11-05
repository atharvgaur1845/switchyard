import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Flow } from "../engine/flow-schema.ts";
import type { Chat } from "../engine/ports.ts";

// Puts each flow's reference documents (from its template) into its Switch
// room, once. A document that already exists is left alone, so edits made
// in the room are never overwritten by a restart.
export async function seedDocuments(chat: Chat, flows: Flow[], templatesDir = "templates"): Promise<string[]> {
  if (!chat.documents || !chat.createDocument) return [];
  const created: string[] = [];
  for (const flow of flows) {
    const path = `${templatesDir}/${flow.flow}.template.yaml`;
    if (!existsSync(path)) continue;
    const docs = (parse(readFileSync(path, "utf8")).room?.docs ?? []) as { name: string; description?: string; instructions?: string; content: string }[];
    if (docs.length === 0) continue;
    const existing = new Set((await chat.documents(flow.room)).map((d) => d.name));
    for (const doc of docs.filter((d) => !existing.has(d.name))) {
      await chat.createDocument(flow.room, { name: doc.name, description: doc.description, instructions: doc.instructions, content: doc.content });
      created.push(`#${flow.room}/${doc.name}`);
    }
  }
  return created;
}
