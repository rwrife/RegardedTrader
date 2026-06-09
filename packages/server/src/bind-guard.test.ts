import { describe, it, expect } from 'vitest';
import {
  assertLoopbackHost,
  isLoopbackAddress,
  isLoopbackOrigin,
} from './bind-guard.js';

describe('isLoopbackAddress', () => {
  it('accepts 127.0.0.0/8', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('127.255.255.254')).toBe(true);
  });
  it('accepts ::1 and IPv4-mapped loopback', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });
  it('rejects non-loopback addresses', () => {
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('192.168.1.1')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    expect(isLoopbackAddress('2001:db8::1')).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
  });
  it('rejects non-loopback origins', () => {
    expect(isLoopbackOrigin('http://evil.com')).toBe(false);
    expect(isLoopbackOrigin('http://192.168.1.5:3000')).toBe(false);
    expect(isLoopbackOrigin('http://0.0.0.0:3000')).toBe(false);
  });
  it('rejects malformed origins', () => {
    expect(isLoopbackOrigin('not-a-url')).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });
});

describe('assertLoopbackHost', () => {
  it('accepts literal loopback IPs', async () => {
    await expect(assertLoopbackHost('127.0.0.1')).resolves.toBeUndefined();
    await expect(assertLoopbackHost('127.5.6.7')).resolves.toBeUndefined();
    await expect(assertLoopbackHost('::1')).resolves.toBeUndefined();
  });

  it('accepts localhost when it resolves to a loopback address', async () => {
    await expect(
      assertLoopbackHost('localhost', async () => [{ address: '127.0.0.1' }]),
    ).resolves.toBeUndefined();
  });

  it('rejects 0.0.0.0', async () => {
    await expect(assertLoopbackHost('0.0.0.0')).rejects.toThrow(
      /non-loopback host "0\.0\.0\.0"/,
    );
  });

  it('rejects external IPs', async () => {
    await expect(assertLoopbackHost('8.8.8.8')).rejects.toThrow(
      /non-loopback host "8\.8\.8\.8"/,
    );
    await expect(assertLoopbackHost('192.168.1.5')).rejects.toThrow(
      /non-loopback host/,
    );
  });

  it('rejects hostnames that resolve to a non-loopback address', async () => {
    await expect(
      assertLoopbackHost('sneaky.example.com', async () => [
        { address: '203.0.113.5' },
      ]),
    ).rejects.toThrow(/non-loopback host "sneaky\.example\.com"/);
  });

  it('rejects hostnames where any resolved address is non-loopback', async () => {
    await expect(
      assertLoopbackHost('mixed', async () => [
        { address: '127.0.0.1' },
        { address: '10.0.0.5' },
      ]),
    ).rejects.toThrow(/non-loopback/);
  });

  it('rejects when DNS lookup fails', async () => {
    await expect(
      assertLoopbackHost('nope.invalid', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/could not resolve host "nope\.invalid"/);
  });

  it('points the user at `regard config` in the error', async () => {
    await expect(assertLoopbackHost('0.0.0.0')).rejects.toThrow(/regard config/);
  });

  it('rejects empty host', async () => {
    await expect(assertLoopbackHost('')).rejects.toThrow(/server\.host is empty/);
  });
});
