export interface SseMessage {
  event: string;
  data: string;
}

export async function readSse(
  url: string,
  onMessage: (msg: SseMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (!res.body) {
    throw new Error('SSE stream returned an empty body');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx < 0) break;
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split(/\r?\n/);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) {
        onMessage({ event, data: dataLines.join('\n') });
      }
    }
  }
}
