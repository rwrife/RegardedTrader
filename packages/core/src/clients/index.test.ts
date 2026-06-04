import { describe, expect, it } from 'vitest';
import { mapYahooOptionContract } from './index.js';
import { YahooOptionContractRaw } from '../schemas/marketData.js';

describe('mapYahooOptionContract', () => {
  const sampleCall = {
    contractSymbol: 'NVDA250620C00130000',
    strike: 130,
    expiration: new Date('2025-06-20T20:00:00.000Z'),
    bid: 4.25,
    ask: 4.35,
    lastPrice: 4.3,
    volume: 1234,
    openInterest: 5678,
    impliedVolatility: 0.412,
  };

  it('maps a fully-populated Yahoo call into an OptionContract', () => {
    const parsed = YahooOptionContractRaw.parse(sampleCall);
    const mapped = mapYahooOptionContract(parsed, 'NVDA', 'call');
    expect(mapped).toEqual({
      symbol: 'NVDA250620C00130000',
      underlying: 'NVDA',
      expiry: '2025-06-20',
      strike: 130,
      type: 'call',
      bid: 4.25,
      ask: 4.35,
      last: 4.3,
      volume: 1234,
      openInterest: 5678,
      iv: 0.412,
    });
  });

  it('maps a thin put leg with missing bid/ask/volume/IV to nulls', () => {
    const thin = YahooOptionContractRaw.parse({
      contractSymbol: 'SPY250620P00500000',
      strike: 500,
      expiration: new Date('2025-06-20T20:00:00.000Z'),
      lastPrice: 1.1,
    });
    const mapped = mapYahooOptionContract(thin, 'SPY', 'put');
    expect(mapped).toMatchObject({
      symbol: 'SPY250620P00500000',
      underlying: 'SPY',
      expiry: '2025-06-20',
      strike: 500,
      type: 'put',
      bid: null,
      ask: null,
      last: 1.1,
      volume: null,
      openInterest: null,
      iv: null,
    });
  });

  it('accepts an epoch-seconds expiration', () => {
    const parsed = YahooOptionContractRaw.parse({
      contractSymbol: 'AAPL250620C00200000',
      strike: 200,
      expiration: 1750449600, // 2025-06-20T20:00:00Z
    });
    const mapped = mapYahooOptionContract(parsed, 'AAPL', 'call');
    expect(mapped.expiry).toBe('2025-06-20');
  });

  it('accepts an ISO-string expiration', () => {
    const parsed = YahooOptionContractRaw.parse({
      contractSymbol: 'AAPL250620C00200000',
      strike: 200,
      expiration: '2025-06-20T20:00:00.000Z',
    });
    const mapped = mapYahooOptionContract(parsed, 'AAPL', 'call');
    expect(mapped.expiry).toBe('2025-06-20');
  });

  it('treats explicit null bid/ask/volume/IV the same as undefined', () => {
    const parsed = YahooOptionContractRaw.parse({
      contractSymbol: 'TSLA250620C00250000',
      strike: 250,
      expiration: new Date('2025-06-20T20:00:00.000Z'),
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      impliedVolatility: null,
    });
    const mapped = mapYahooOptionContract(parsed, 'TSLA', 'call');
    expect(mapped.bid).toBeNull();
    expect(mapped.ask).toBeNull();
    expect(mapped.last).toBeNull();
    expect(mapped.volume).toBeNull();
    expect(mapped.openInterest).toBeNull();
    expect(mapped.iv).toBeNull();
  });

  it('YahooOptionContractRaw rejects rows missing required fields', () => {
    const res = YahooOptionContractRaw.safeParse({
      // contractSymbol missing
      strike: 100,
      expiration: new Date(),
    });
    expect(res.success).toBe(false);
  });
});
