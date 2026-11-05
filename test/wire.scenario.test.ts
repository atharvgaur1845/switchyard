import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { LiveOutlets } from "../src/outlets/index.ts";
import { startServer } from "../src/server.ts";
import { SwitchClient } from "../src/switch/client.ts";
import { FakeSwitchHttp } from "./fake-switch-http.ts";
import { replyWith } from "./fake-switch.ts";

const expense = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));

async function until<T>(check: () => T | undefined, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("over the wire: web form -> Switch -> approval -> ledger", () => {
  let fake: FakeSwitchHttp, client: SwitchClient, server: Server;

  afterEach(async () => {
    client.stop();
    server.close();
    await fake.stop();
  });

  it("runs the expense flow through the real client and form server", async () => {
    fake = new FakeSwitchHttp().agent("policy", replyWith({ verdict: "ok", reasons: ["fine"] }));
    const baseUrl = await fake.start();
    const dataDir = mkdtempSync(join(tmpdir(), "switchyard-wire-"));
    const store = new Store();
    client = new SwitchClient({ baseUrl, agentId: "yard-1", apiKey: "key-1", rooms: { "ops-requests": "room-1" } });
    const outlets = new LiveOutlets({ dataDir, smtp: { host: "localhost", port: 1025, from: "x@y" } }, client, store);
    const runner = new Runner(store, client, outlets, [expense]);
    client.onMessage((m) => runner.onMessage(m));
    client.onApproval((o) => runner.onApproval(o));
    await client.start();
    server = startServer({ port: 0, flows: [expense], runner, store });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;

    const form = new URLSearchParams({ name: "Asha", email: "asha@example.test", amount: "820", category: "travel", reason: "client visit" });
    const page = await fetch(`http://127.0.0.1:${port}/f/expense`, { method: "POST", body: form });
    expect(await page.text()).toContain("Your request is case");

    const card = await until(() => fake.cards[0]);
    expect(card).toMatchObject({ room_id: "room-1", kind: "approval", thread_id: "ev-1" });
    expect(String(card.detail)).toContain("Asha | 820 | travel");

    fake.answer(String(card.request_id), "approve", "@switch-mattermost-b1-manager:localhost");
    await until(() => fake.posts.find((p) => p.body.startsWith("Case") && p.body.endsWith("is done.")));

    const ledger = readFileSync(join(dataDir, "ledger.csv"), "utf8");
    expect(ledger).toMatch(/,Asha,820,travel\n$/);
    expect(fake.posts.every((p) => p.room === "room-1")).toBe(true);
    expect(fake.posts.slice(1).every((p) => p.thread_id === "ev-1")).toBe(true);
    expect(fake.beats.size).toBe(1);
  }, 15_000);

  it("rejects a form with a non-number amount without opening a case", async () => {
    fake = new FakeSwitchHttp();
    const baseUrl = await fake.start();
    const store = new Store();
    client = new SwitchClient({ baseUrl, agentId: "yard-1", apiKey: "key-1", rooms: { "ops-requests": "room-1" } });
    await client.start();
    const runner = new Runner(store, client, { execute: async () => "" }, [expense]);
    server = startServer({ port: 0, flows: [expense], runner, store });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;

    const form = new URLSearchParams({ name: "A", email: "a@b.co", amount: "lots", category: "x", reason: "y" });
    const response = await fetch(`http://127.0.0.1:${port}/f/expense`, { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Amount must be a number");
    expect(store.caseIds()).toHaveLength(0);
  });
});
