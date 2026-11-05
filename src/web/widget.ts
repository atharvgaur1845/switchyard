import { escapeHtml } from "../inlets/form.ts";

// The front-desk chat page. Embed it on a site with
//   <iframe src="https://<switchyard host>/chat" width="380" height="600"></iframe>
// Each question opens a case; the page polls for the reply Switchyard sends
// back, which only arrives once the flow's rules or a person allow it.
export function widgetPage(title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/static/logo.svg">
<link rel="stylesheet" href="/static/theme.css">
<style>
html, body { height: 100%; }
body { display: grid; place-items: center; padding: 16px; }
.chat { width: 100%; max-width: 420px; height: min(640px, calc(100vh - 32px)); display: grid; grid-template-rows: auto 1fr auto; overflow: hidden; }
.chat header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.chat header .av { width: 36px; height: 36px; border-radius: 50%; background: var(--ink); color: var(--bg); display: grid; place-items: center; font-weight: 700; }
.chat header b { display: block; }
.chat header small { color: var(--muted); display: flex; align-items: center; gap: 6px; }
.chat header small i { width: 7px; height: 7px; border-radius: 50%; background: var(--act); display: inline-block; }
#log { overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: var(--surface-2); }
.msg { max-width: 85%; padding: 9px 13px; border-radius: 16px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
.me { align-self: flex-end; background: var(--ink); color: var(--bg); border-bottom-right-radius: 5px; }
.them { align-self: flex-start; background: var(--surface); border: 1px solid var(--line); border-bottom-left-radius: 5px; }
.status { align-self: flex-start; display: inline-flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12.5px; padding: 2px 4px; }
.status.review { color: var(--person); }
.typing { display: inline-flex; gap: 3px; }
.typing i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: bounce 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
@keyframes bounce { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing i { animation: none; } }
.hello { color: var(--ink-2); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; font-size: 13px; }
form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); background: var(--surface); }
textarea { flex: 1; resize: none; border: 1px solid var(--line-strong); border-radius: 10px; padding: 9px 12px; font: inherit; background: var(--surface-2); color: var(--ink); max-height: 120px; }
textarea:focus { outline: none; border-color: var(--focus); }
.send { width: 40px; height: 40px; padding: 0; border-radius: 10px; flex: none; }
.foot { text-align: center; color: var(--muted); font-size: 11px; padding: 0 0 10px; background: var(--surface); }
</style></head><body>
<div class="chat card">
  <header><span class="av">${escapeHtml(title.replace(/^Ask\s+/i, "").slice(0, 1).toUpperCase())}</span>
    <div><b>${escapeHtml(title)}</b><small><i></i>Usually answers in a minute</small></div></header>
  <div id="log" aria-live="polite">
    <div class="hello">Hi! Ask us anything about our services. Simple questions are answered right away; anything about money, refunds or your account goes to a person first.</div>
  </div>
  <div>
    <form id="ask">
      <label for="q" class="visually-hidden" style="position:absolute;left:-9999px">Your question</label>
      <textarea id="q" rows="1" maxlength="2000" placeholder="Type your question…" required></textarea>
      <button class="btn send" type="submit" aria-label="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </form>
    <div class="foot">Replies are checked by the team · Switchyard</div>
  </div>
</div>
<script>
const log = document.getElementById("log");
const box = document.getElementById("q");
function add(kind, text) {
  const el = document.createElement("div");
  el.className = kind;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
function typing() {
  const el = document.createElement("div");
  el.className = "status";
  el.innerHTML = '<span class="typing"><i></i><i></i><i></i></span><span>Looking into it…</span>';
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
async function waitFor(caseId, note) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch("/chat/" + encodeURIComponent(caseId));
    if (!res.ok) continue;
    const { replies, status } = await res.json();
    if (replies.length > 0) {
      note.remove();
      replies.forEach((r) => add("msg them", r.body));
      return;
    }
    if (status === "waiting_on_staff") {
      note.className = "status review";
      note.textContent = "A person on the team is reviewing this. The answer will appear here.";
    }
    if (status === "closed") {
      note.className = "status review";
      note.textContent = "The team will follow up with you directly.";
      return;
    }
  }
}
box.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("ask").requestSubmit(); }
});
document.getElementById("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = box.value.trim();
  if (!question) return;
  box.value = "";
  add("msg me", question);
  const note = typing();
  const res = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
  if (!res.ok) { note.textContent = "Sorry, that didn't go through. Please try again."; return; }
  const { case: caseId } = await res.json();
  waitFor(caseId, note);
});
</script></body></html>`;
}
