import { describe, expect, it } from 'vitest';
import { parseWatchArgs } from './watch.js';

describe('parseWatchArgs', () => {
  it('returns an error when no subcommand is provided', () => {
    const r = parseWatchArgs([]);
    expect(r.kind).toBe('error');
  });

  it('routes ls (and list alias) to the list screen', () => {
    expect(parseWatchArgs(['ls']).kind).toBe('ls');
    expect(parseWatchArgs(['list']).kind).toBe('ls');
    expect(parseWatchArgs(['LS']).kind).toBe('ls');
  });

  it('uppercases and de-dupes whitespace for add', () => {
    const r = parseWatchArgs(['add', 'nvda', 'aapl']);
    expect(r.kind).toBe('add');
    if (r.kind === 'add') expect(r.symbols).toEqual(['NVDA', 'AAPL']);
  });

  it('errors when add has no symbols', () => {
    expect(parseWatchArgs(['add']).kind).toBe('error');
  });

  it('uppercases the symbol for rm and accepts the remove alias', () => {
    const r1 = parseWatchArgs(['rm', 'nvda']);
    expect(r1.kind).toBe('rm');
    if (r1.kind === 'rm') expect(r1.symbol).toBe('NVDA');
    const r2 = parseWatchArgs(['remove', 'aapl']);
    expect(r2.kind).toBe('rm');
  });

  it('errors when rm has no symbol', () => {
    expect(parseWatchArgs(['rm']).kind).toBe('error');
  });

  it('errors on unknown subcommands instead of silently dispatching', () => {
    const r = parseWatchArgs(['burn', 'NVDA']);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/burn/);
  });
});
