import { describe, expect, it } from 'vitest';
import { parseClaudeJsonl, parseCodexJsonl } from './parsers.js';

describe('parseCodexJsonl', () => {
  it('returns last agent text and session id', () => {
    const out = [
      '{"type":"session","session_id":"sess-123"}',
      '{"type":"agent_message","message":{"content":"first"}}',
      '{"type":"agent_message","message":{"content":"final answer"}}',
    ].join('\n');

    expect(parseCodexJsonl(out)).toEqual({
      text: 'final answer',
      sessionId: 'sess-123',
    });
  });

  it('ignores malformed jsonl lines', () => {
    const out = ['not-json', '{"message":{"content":"ok"}}'].join('\n');
    expect(parseCodexJsonl(out)).toEqual({ text: 'ok', sessionId: undefined });
  });
});

describe('parseClaudeJsonl', () => {
  it('uses final result and captures session id', () => {
    const out = [
      '{"type":"session","session_id":"claude-001"}',
      '{"type":"assistant","message":{"content":"draft"}}',
      '{"result":"final"}',
    ].join('\n');

    expect(parseClaudeJsonl(out)).toEqual({ text: 'final', sessionId: 'claude-001' });
  });

  it('falls back to raw output when no JSON lines parse', () => {
    expect(parseClaudeJsonl('plain text output')).toEqual({
      text: 'plain text output',
      sessionId: undefined,
    });
  });
});
