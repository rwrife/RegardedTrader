import { describe, expect, it } from 'vitest';
import { parseWatchArgs } from './watch.js';

describe('parseWatchArgs', () => {
  it('defaults to tape mode when no args are provided', () => {
    const r = parseWatchArgs([]);
    expect(r.kind).toBe('tape');
  });

  it('routes ls (and list alias) to legacy list handling', () => {
    expect(parseWatchArgs(['ls']).kind).toBe('legacy-ls');
    expect(parseWatchArgs(['list']).kind).toBe('legacy-ls');
    expect(parseWatchArgs(['LS']).kind).toBe('legacy-ls');
  });

  it('uppercases symbols for legacy add', () => {
    const r = parseWatchArgs(['add', 'nvda', 'aapl']);
    expect(r.kind).toBe('legacy-add');
    if (r.kind === 'legacy-add') expect(r.symbols).toEqual(['NVDA', 'AAPL']);
  });

  it('errors when add has no symbols', () => {
    expect(parseWatchArgs(['add']).kind).toBe('error');
  });

  it('uppercases the symbol for rm and accepts the remove alias', () => {
    const r1 = parseWatchArgs(['rm', 'nvda']);
    expect(r1.kind).toBe('legacy-rm');
    if (r1.kind === 'legacy-rm') expect(r1.symbol).toBe('NVDA');
    const r2 = parseWatchArgs(['remove', 'aapl']);
    expect(r2.kind).toBe('legacy-rm');
  });

  it('errors when rm has no symbol', () => {
    expect(parseWatchArgs(['rm']).kind).toBe('error');
  });

  it('treats non-legacy input as tape symbols', () => {
    const r = parseWatchArgs(['nvda', 'aapl']);
    expect(r.kind).toBe('tape');
    if (r.kind === 'tape') expect(r.symbols).toEqual(['NVDA', 'AAPL']);
  });
});
