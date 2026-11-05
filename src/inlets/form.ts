// Web forms generated from a flow's `inlet.form.fields`. A field is written
// `name` or `name:type`, with type one of text, email, number or long.

export type FieldKind = "text" | "email" | "number" | "long";

export interface FormField {
  name: string;
  kind: FieldKind;
}

const KINDS: FieldKind[] = ["text", "email", "number", "long"];

export function formFields(inlet: Record<string, unknown> | undefined): FormField[] | undefined {
  const form = inlet?.form as { fields?: unknown } | undefined;
  if (!form || !Array.isArray(form.fields)) return undefined;
  return form.fields.map((spec) => {
    const [name, kind = "text"] = String(spec).split(":");
    if (!KINDS.includes(kind as FieldKind)) throw new Error(`form field "${spec}": unknown type "${kind}"`);
    return { name, kind: kind as FieldKind };
  });
}

// Turns submitted strings into case data, or explains what is wrong.
export function readSubmission(
  fields: FormField[],
  submitted: URLSearchParams,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (submitted.get(field.name) ?? "").trim();
    if (raw === "") return { ok: false, error: `${label(field.name)} is required` };
    if (raw.length > 5_000) return { ok: false, error: `${label(field.name)} is too long` };
    if (field.kind === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { ok: false, error: `${label(field.name)} must be a number` };
      data[field.name] = value;
    } else if (field.kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
      return { ok: false, error: `${label(field.name)} must be an email address` };
    } else {
      data[field.name] = raw;
    }
  }
  return { ok: true, data };
}

export function renderForm(flow: string, title: string, fields: FormField[], message?: string): string {
  const inputs = fields
    .map((field) => {
      const id = `f-${field.name}`;
      const attrs = `id="${id}" name="${field.name}" required`;
      const control =
        field.kind === "long"
          ? `<textarea ${attrs} rows="4"></textarea>`
          : `<input ${attrs} type="${field.kind === "number" ? "number" : field.kind}"${field.kind === "number" ? ' step="any" inputmode="decimal"' : ""}>`;
      return `<label class="field" for="${id}"><span>${escapeHtml(label(field.name))}</span>${control}</label>`;
    })
    .join("\n");
  return page(
    title,
    `<form class="form-card card" method="post" action="/f/${flow}">
  ${brandRow()}
  <h1>${escapeHtml(title)}</h1>
  <p class="lede">Fill this in and the team picks it up in their chat right away.</p>
  ${message ? `<div class="notice error" role="alert">${escapeHtml(message)}</div>` : ""}
  ${inputs}
  <div style="margin-top:22px"><button class="btn" type="submit">Submit request</button></div>
  <p class="fineprint">${LOCK} Agents help review this, but every decision and anything sent back is approved by a person.</p>
</form>`,
  );
}

export function receivedPage(title: string, caseId: string): string {
  return page(
    title,
    `<div class="form-card card">
  ${brandRow()}
  <h1>Request received</h1>
  <div class="notice ok">Your request is case <b class="mono">${escapeHtml(caseId)}</b>. The team has it now.</div>
  <p class="fineprint">${LOCK} You'll hear back once a person has reviewed it.</p>
  <p style="margin-top:18px"><a href="">Submit another</a></p>
</div>`,
  );
}

const LOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="flex:none;margin-top:2px"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function brandRow(): string {
  return `<a class="brand" href="#" aria-label="Switchyard" style="color:var(--muted);font-size:13px"><img src="/static/logo.svg" alt="" width="18" height="18" class="logo"> Switchyard</a>`;
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/static/logo.svg">
<link rel="stylesheet" href="/static/theme.css">
<style>@media (prefers-color-scheme: dark) { .logo { filter: invert(1); } }</style>
</head><body><main class="page-narrow">${body}</main></body></html>`;
}

function label(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
