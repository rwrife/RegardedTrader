import OpenAI from 'openai';

export interface LLM {
  complete(opts: { system: string; user: string; json?: boolean }): Promise<string>;
}

export class OpenAILLM implements LLM {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async complete({ system, user, json }: { system: string; user: string; json?: boolean }) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      response_format: json ? { type: 'json_object' } : undefined,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? '';
  }
}

export const DISCLAIMER =
  'Educational/research output. Not financial advice. You are responsible for your own trades.';
