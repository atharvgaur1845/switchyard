// Server-sent events framing, per the HTML spec, for the agent event stream.
// Frames are separated by a blank line; `id:` marks a resumable domain event.

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";

  // Feeds a chunk of the stream and returns the frames it completed.
  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const frames: SseFrame[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // keepalive comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n"), id };
}
