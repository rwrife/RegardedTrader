export interface ParsedCliOutput {
  text: string;
  sessionId?: string;
}

const MAX_JSONL_BYTES = 1_000_000;
const MAX_JSONL_LINES = 5_000;

export function parseCodexJsonl(out: string): ParsedCliOutput {
  let last = '';
  let sessionId: string | undefined;
  for (const obj of boundedJsonl(out)) {
    const text =
      pickString(obj?.message?.content) ??
      pickString(obj?.content) ??
      pickString(obj?.text) ??
      (obj?.type === 'agent_message' ? pickString(obj?.message) : undefined);
    if (text) last = text;
    sessionId = pickString(obj?.session_id) ?? pickString(obj?.sessionId) ?? pickString(obj?.session?.id) ?? sessionId;
  }
  return { text: last || out.trim(), sessionId };
}

export function parseClaudeJsonl(out: string): ParsedCliOutput {
  let last = '';
  let sessionId: string | undefined;
  for (const obj of boundedJsonl(out)) {
    const text =
      pickString(obj?.result) ??
      (obj?.type === 'assistant' ? pickString(obj?.message?.content) : undefined) ??
      (obj?.type === 'message' ? pickString(obj?.message?.content) : undefined);
    if (text) last = text;
    sessionId = pickString(obj?.session_id) ?? pickString(obj?.sessionId) ?? pickString(obj?.session?.id) ?? sessionId;
  }
  return { text: last || out.trim(), sessionId };
}

function* boundedJsonl(out: string): Generator<any, void, unknown> {
  const safe = out.length > MAX_JSONL_BYTES ? out.slice(out.length - MAX_JSONL_BYTES) : out;
  const lines = safe.split(/\r?\n/).filter(Boolean);
  const tail = lines.length > MAX_JSONL_LINES ? lines.slice(lines.length - MAX_JSONL_LINES) : lines;
  for (const line of tail) {
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore non-JSON lines.
    }
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}
