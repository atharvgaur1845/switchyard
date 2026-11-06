// What the company's own mail gateway said about an email's sender: SPF,
// DKIM and DMARC, from its Authentication-Results header (RFC 8601).
//
// Anyone can write an Authentication-Results header into a message, so only
// one is believed: the topmost, and only when it names the gateway
// configured as trusted (`inlet.email.trusted_gateway`). RFC 8601 section 5
// requires that gateway to remove headers already carrying its name, so a
// planted header sits below it, or is gone. Without a trusted gateway, or
// without its header, the result is "unavailable", never a pass.

export type MailAuth =
  | { available: true; gateway: string; spf?: string; dkim?: string; dkim_domains: string[]; dmarc?: string; dmarc_from?: string }
  | { available: false; reason: string };

export function mailAuth(headers: Record<string, string[] | string | undefined>, trusted: string | undefined): MailAuth {
  if (!trusted) return { available: false, reason: "no trusted mail gateway is configured" };
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "authentication-results");
  const raw = key ? headers[key] : undefined;
  const top = (Array.isArray(raw) ? raw[0] : raw)?.replace(/\s+/g, " ").trim();
  if (!top) return { available: false, reason: `the message has no Authentication-Results from ${trusted}` };
  // authserv-id, optionally followed by a version number.
  const id = top.split(";")[0].trim().split(/\s+/)[0].toLowerCase();
  if (id !== trusted.toLowerCase()) return { available: false, reason: `the topmost Authentication-Results is from "${id}", not the trusted gateway ${trusted}` };
  const result = (method: string) => new RegExp(`(?:^|;)\\s*${method}=([a-z]+)`, "i").exec(top)?.[1]?.toLowerCase();
  const dkimDomains = [...top.matchAll(/(?:^|;)\s*dkim=pass\b[^;]*?\bheader\.d=([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  const dmarcFrom = /(?:^|;)\s*dmarc=[a-z]+\b[^;]*?\bheader\.from=([a-z0-9.-]+)/i.exec(top)?.[1]?.toLowerCase();
  return { available: true, gateway: trusted, spf: result("spf"), dkim: result("dkim"), dkim_domains: dkimDomains, dmarc: result("dmarc"), dmarc_from: dmarcFrom };
}

// Whether the gateway vouches for this sender's domain: DMARC passed for it,
// or a DKIM signature of that domain (or its parent) verified.
export function authenticated(auth: MailAuth | undefined, senderDomain: string): boolean {
  if (!auth?.available) return false;
  const domain = senderDomain.toLowerCase();
  const covers = (d: string) => domain === d || domain.endsWith(`.${d}`);
  if (auth.dmarc === "pass" && (!auth.dmarc_from || covers(auth.dmarc_from))) return true;
  return auth.dkim_domains.some(covers);
}
