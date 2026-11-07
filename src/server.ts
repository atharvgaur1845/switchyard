import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Flow } from "./engine/flow-schema.ts";
import type { Runner } from "./engine/runner.ts";
import type { Store } from "./engine/store.ts";
import { fineprint, formFields, readSubmission, receivedPage, renderForm } from "./inlets/form.ts";
import { screen } from "./inlets/screen.ts";
import { mapPayload, verifySignature, webhookInlet } from "./inlets/webhook.ts";
import { readFile } from "node:fs/promises";
import { caseSummaries, type Extras, overview } from "./web/api.ts";
import { investigations } from "./web/investigations.ts";
import { buildProof, fingerprint, signProof, verifyProof } from "./proof.ts";
import { createPublicKey, type KeyObject } from "node:crypto";
import { widgetPage } from "./web/widget.ts";

const MAX_BODY = 256 * 1024;
// A proof carries its whole event log.
const MAX_PROOF = 4 * 1024 * 1024;
const STARTED = Date.now().toString(36);

// The only files served from disk, by exact name.
const STATIC: Record<string, string> = {
  "theme.css": "text/css",
  "app.css": "text/css",
  "app.js": "text/javascript",
  "diagram.js": "text/javascript",
  "icons.js": "text/javascript",
  "investigations.js": "text/javascript",
  "console.css": "text/css",
  "command.js": "text/javascript",
  "agents.js": "text/javascript",
  "proofs.js": "text/javascript",
  "lab.js": "text/javascript",
  "replay.js": "text/javascript",
  "views.js": "text/javascript",
  "decisions.js": "text/javascript",
  "commitments.js": "text/javascript",
  "about.js": "text/javascript",
  "logo.svg": "image/svg+xml",
};

// The HTTP side of Switchyard: forms at /f/<flow>, webhooks at /in/<flow>,
// and the read-only case API the dashboard draws from.
export function startServer(opts: {
  port: number;
  flows: Flow[];
  runner: Runner;
  store: Store;
  // Flows on disk that are not running yet, shown on the dashboard only.
  available?: Flow[];
  extras?: Extras;
  env?: NodeJS.ProcessEnv;
  // Signs the proofs the dashboard hands out (proof.ts); unsigned without it.
  proofKey?: KeyObject;
  // The key fingerprint proofs are checked against (proof.fingerprint in
  // switchyard.yaml); this Switchyard's own key when none is pinned.
  proofFingerprint?: string;
  // Serving `demo offline`: its sandbox cases, labelled so on every page.
  // `public` opens the console to anyone (a hosted demo behind a proxy) and
  // makes it read-only: nothing can open a case, only look and check.
  demo?: { public: boolean };
}): Server {
  const flows = new Map(opts.flows.map((f) => [f.flow, f]));
  const frontDesk = opts.flows.find((f) => f.inlet?.frontdesk);
  const env = opts.env ?? process.env;
  const ownFingerprint = opts.proofKey ? fingerprint(createPublicKey(opts.proofKey).export({ type: "spki", format: "pem" }).toString()) : undefined;
  const pinned = opts.proofFingerprint ? { fingerprint: opts.proofFingerprint, from: "proof.fingerprint in switchyard.yaml" } : ownFingerprint ? { fingerprint: ownFingerprint, from: "this Switchyard's signing key" } : undefined;
  // One lab run at a time: each starts its own sandbox bank and engine.
  let labBusy = false;

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      console.error(`[switchyard] ${req.method} ${req.url}:`, error);
      if (!res.headersSent) send(res, 500, "text/plain", "Switchyard hit an error; it is in the log.");
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://switchyard");
    const [, kind, name] = url.pathname.split("/");
    const flow = name ? flows.get(name) : undefined;

    // Forms, webhooks and the chat widget are for outsiders. The dashboard
    // and its API show case data, so they answer only on this machine or to
    // someone holding the dashboard token.
    if (opts.demo?.public && (kind === "f" || kind === "in" || (kind === "chat" && req.method === "POST"))) {
      return send(res, 403, "text/plain", "This is a read-only public demo of an offline run: nothing here opens a case. Run it yourself with `npm run demo:offline`.");
    }
    if ((kind === "api" || url.pathname === "/" || (kind === "static" && name === "app.js")) && !opts.demo?.public && !mayView(req, url, env)) {
      return send(res, 403, "text/plain", "The dashboard is only served on localhost or with ?token=.");
    }

    if (kind === "f" && flow) {
      const fields = formFields(flow.inlet);
      if (!fields) return send(res, 404, "text/plain", "This flow has no form.");
      const title = flow.description ?? flow.flow;
      const promise = fineprint(flow.steps.flatMap((s) => ("auto_approve" in s && s.auto_approve !== false ? [String(s.auto_approve)] : [])));
      if (req.method === "GET") return send(res, 200, "text/html", renderForm(flow.flow, title, fields, undefined, promise));
      if (req.method !== "POST") return send(res, 405, "text/plain", "Use GET or POST.");

      const submitted = readSubmission(fields, new URLSearchParams(await readBody(req)));
      if (!submitted.ok) return send(res, 400, "text/html", renderForm(flow.flow, title, fields, submitted.error, promise));
      const id = await opts.runner.open(flow.flow, submitted.data, "web form");
      return send(res, 200, "text/html", receivedPage(title, id));
    }

    if (kind === "in" && flow && req.method === "POST") {
      const inlet = webhookInlet(flow.inlet);
      if (!inlet) return send(res, 404, "application/json", JSON.stringify({ error: "this flow has no webhook" }));
      const raw = await readBody(req);
      if (inlet.secret_env) {
        const secret = env[inlet.secret_env];
        const signature = req.headers["x-switchyard-signature"];
        if (!secret || !verifySignature(secret, raw, typeof signature === "string" ? signature : undefined)) {
          return send(res, 401, "application/json", JSON.stringify({ error: "bad signature" }));
        }
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(res, 400, "application/json", JSON.stringify({ error: "body is not JSON" }));
      }
      // Senders retry. The delivery id they send, or else the exact body,
      // identifies a delivery, so a retry gets the case it already opened.
      const delivery = req.headers["x-switchyard-delivery"];
      const key = typeof delivery === "string" && delivery ? `delivery:${delivery}` : `body:${createHash("sha256").update(raw).digest("hex")}`;
      const before = new Set(opts.store.caseIds());
      const id = await opts.runner.open(flow.flow, mapPayload(inlet, payload), "webhook", key);
      const known = before.has(id);
      return send(res, known ? 200 : 202, "application/json", JSON.stringify(known ? { case: id, duplicate: true } : { case: id }));
    }

    if (kind === "chat" && frontDesk) {
      if (!name && req.method === "GET") {
        const title = (frontDesk.inlet!.frontdesk as { title?: string }).title ?? "Ask us";
        return send(res, 200, "text/html", widgetPage(title));
      }
      if (!name && req.method === "POST") {
        let question: unknown;
        try {
          question = JSON.parse(await readBody(req)).question;
        } catch {
          return send(res, 400, "application/json", JSON.stringify({ error: "body is not JSON" }));
        }
        if (typeof question !== "string" || !question.trim() || question.length > 2000) {
          return send(res, 400, "application/json", JSON.stringify({ error: "question must be 1-2000 characters" }));
        }
        const id = await opts.runner.open(frontDesk.flow, { question: question.trim(), ...screen(question) }, "website visitor");
        return send(res, 200, "application/json", JSON.stringify({ case: id }));
      }
      if (name && req.method === "GET") {
        if (!opts.store.caseIds().includes(name)) return send(res, 404, "application/json", "{}");
        const state = opts.store.load(name);
        if (state.flow !== frontDesk.flow) return send(res, 404, "application/json", "{}");
        const status =
          state.status !== "open" ? "closed" : state.pending?.kind === "gate" ? "waiting_on_staff" : "working";
        // Only replies and a coarse status reach the visitor; nothing internal does.
        return send(res, 200, "application/json", JSON.stringify({ status, replies: opts.store.visitorReplies(name) }));
      }
    }

    if (kind === "api" && name === "cases" && req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify(caseSummaries(opts.store, opts.flows)));
    }

    // Checks a proof file, as `verify-proof` does: nothing but the file and
    // the pinned fingerprint. The dashboard sends the proof it downloaded, or
    // one a person dropped in (an edited copy fails).
    if (kind === "api" && name === "verify-proof" && req.method === "POST") {
      let proof: unknown;
      try {
        proof = JSON.parse(await readBody(req, MAX_PROOF));
      } catch {
        return send(res, 400, "application/json", JSON.stringify({ error: "not a JSON proof file" }));
      }
      try {
        const findings = verifyProof(proof as Parameters<typeof verifyProof>[0], pinned?.fingerprint);
        return send(res, 200, "application/json", JSON.stringify({ findings, pinned }));
      } catch (error) {
        return send(res, 200, "application/json", JSON.stringify({ findings: [{ ok: false, what: `the file is a proof Switchyard can read (${(error as Error).message})` }], pinned }));
      }
    }

    if (kind === "api" && name === "lab" && req.method === "GET") {
      const { loadHeldOut } = await import("./lab-heldout.ts");
      return send(res, 200, "application/json", JSON.stringify(loadHeldOut().map(({ steps, ...s }) => ({ ...s, steps: steps.map((st) => Object.keys(st)[0]) }))));
    }

    if (kind === "api" && name === "lab" && req.method === "POST") {
      if (labBusy) return send(res, 409, "application/json", JSON.stringify({ error: "a lab run is in progress" }));
      let body: { id?: unknown; links?: unknown; fooled?: unknown; bank?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, "application/json", JSON.stringify({ error: "body is not JSON" }));
      }
      if (typeof body.id !== "string" || !/^H\d{2}$/.test(body.id)) return send(res, 400, "application/json", JSON.stringify({ error: "id must be a held-out scenario, H01-H20" }));
      labBusy = true;
      try {
        const { runHeldOut } = await import("./lab-heldout.ts");
        const result = await runHeldOut(body.id, { links: body.links === true, fooled: body.fooled === true, bank: body.bank === "oracle" ? "oracle" : "unavailable" });
        return send(res, 200, "application/json", JSON.stringify(result));
      } finally {
        labBusy = false;
      }
    }

    if (kind === "api" && name === "proof" && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (!opts.store.caseIds().includes(id)) return send(res, 404, "application/json", "{}");
      const unsigned = buildProof(opts.store, opts.flows, id);
      const proof = opts.proofKey ? signProof(unsigned, opts.proofKey) : unsigned;
      res.setHeader("Content-Disposition", `attachment; filename="${id}.proof.json"`);
      return send(res, 200, "application/json", JSON.stringify(proof, null, 2));
    }

    if (kind === "api" && name === "investigations" && req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify(investigations(opts.store, opts.flows)));
    }

    if (kind === "api" && name === "overview" && req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify({ ...overview(opts.flows, opts.available, opts.extras), proof: pinned ?? null, demo: opts.demo ?? null }));
    }

    if (kind === "static" && name && STATIC[name] && req.method === "GET") {
      return send(res, 200, STATIC[name], await readFile(new URL(`./web/static/${name}`, import.meta.url), "utf8"));
    }

    if (url.pathname === "/" && req.method === "GET") {
      // Stamp asset URLs with the server's start time, so an open dashboard
      // never runs a stale script after a restart.
      const html = await readFile(new URL("./web/static/index.html", import.meta.url), "utf8");
      return send(res, 200, "text/html", html.replace(/(\/static\/[\w.-]+\.(?:js|css))"/g, `$1?v=${STARTED}"`));
    }

    if (url.pathname === "/health") return send(res, 200, "application/json", '{"ok":true}');
    send(res, 404, "text/plain", "Not found.");
  }

  server.listen(opts.port);
  return server;
}

function mayView(req: IncomingMessage, url: URL, env: NodeJS.ProcessEnv): boolean {
  const token = env.SWITCHYARD_DASHBOARD_TOKEN;
  if (token && (url.searchParams.get("token") === token || req.headers.authorization === `Bearer ${token}`)) return true;
  const address = req.socket.remoteAddress ?? "";
  const forwarded = req.headers["x-forwarded-for"];
  return !forwarded && (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1");
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-cache" });
  res.end(body);
}
