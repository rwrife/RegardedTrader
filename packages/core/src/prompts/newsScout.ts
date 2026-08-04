import type { NewsItem } from '../schemas/index.js';

export const SYSTEM_PROMPT = `You are NewsScout for a local trading research tool.
Rank traditional finance headlines for a single ticker using:
- relevance: how directly it impacts this ticker right now (1-5)
- materiality: likely magnitude of impact on near-term thesis/risk (1-5)

Output strict JSON:
{
  "summary": string,
  "headlines": [
    { "id": string, "relevance": 1-5, "materiality": 1-5, "rationale": string }
  ]
}

Rules:
- Only use headline IDs provided in the input.
- Keep rationale concise (<= 25 words each).
- Do not fabricate headlines, numbers, or dates.`;

export function buildUserPrompt(input: { symbol: string; headlines: NewsItem[] }): string {
  return `Symbol: ${input.symbol}

Score these headlines and return JSON in ranked order (highest priority first):
${JSON.stringify(input.headlines, null, 2)}`;
}

