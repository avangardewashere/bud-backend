import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseTrustProxy } from './trust-proxy.js';

/**
 * Half of this suite tests the parser; the other half tests Fastify, on purpose.
 *
 * What `trustProxy` actually does is not guessable from its type — a number
 * means "trust nothing" in Fastify 5, the opposite of the hop count the Express
 * documentation describes — and the whole value of this setting is that the
 * address the rate limiter keys on cannot be chosen by the caller. So the
 * claims are made against a real Fastify instance with real headers, and they
 * will fail if a Fastify upgrade changes any of them.
 */

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The address Fastify resolves for a caller, given a peer and a forwarded chain. */
async function resolvedIp(
  trustProxy: boolean | string[],
  peer: string,
  forwardedFor?: string,
): Promise<string> {
  const server = Fastify({ trustProxy, logger: false });
  servers.push(server);
  server.get('/ip', (request) => ({ ip: request.ip }));

  const response = await server.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: peer,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });

  return response.json<{ ip: string }>().ip;
}

describe('parseTrustProxy', () => {
  it('defaults to trusting a proxy on loopback or a private network', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('   ')).toEqual(['loopback', 'uniquelocal']);
  });

  it('takes a list of addresses or ranges', () => {
    expect(parseTrustProxy('10.0.0.1, 192.168.0.0/16')).toEqual(['10.0.0.1', '192.168.0.0/16']);
  });

  it('keeps the explicit escape hatches', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('refuses a hop count, which Fastify would read as trusting nothing', () => {
    // The trap this exists for: TRUST_PROXY=1 is what Express documents, looks
    // configured, and would silently put every caller in one bucket.
    expect(() => parseTrustProxy('1')).toThrowError(/hop count/);
  });

  it('refuses a list with nothing in it', () => {
    expect(() => parseTrustProxy(',,')).toThrowError(/no addresses/);
  });
});

describe('what Fastify believes, given the default', () => {
  const trusted = ['loopback', 'uniquelocal'];

  it('reads the caller the proxy vouched for, not the one they claimed', async () => {
    // A proxy appends the address it saw, so the caller's own claim sits to the
    // left of it and is skipped.
    expect(await resolvedIp(trusted, '10.0.0.5', '9.9.9.9, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('reads the forwarded address when the proxy sent only one', async () => {
    expect(await resolvedIp(trusted, '10.0.0.5', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('falls back to the socket when there is no proxy', async () => {
    expect(await resolvedIp(trusted, '10.0.0.5', undefined)).toBe('10.0.0.5');
  });

  it('ignores the header entirely from an untrusted peer', async () => {
    // Someone reaching the API directly from the internet cannot name themselves.
    expect(await resolvedIp(trusted, '198.51.100.9', '9.9.9.9')).toBe('198.51.100.9');
  });

  it('is fooled only by a caller whose own address is already private', async () => {
    // The documented limitation, not an accident: on a LAN deploy the caller is
    // inside the trust, so the address in front of theirs is believed. That is
    // why TRUST_PROXY exists as a setting rather than a constant.
    expect(await resolvedIp(trusted, '10.0.0.5', '203.0.113.7, 10.0.0.9')).toBe('203.0.113.7');
  });
});

describe('what `true` believed, which is why it is no longer the default', () => {
  it('lets the caller name themselves', async () => {
    expect(await resolvedIp(true, '10.0.0.5', '9.9.9.9, 203.0.113.7')).toBe('9.9.9.9');
  });

  it('so a caller can pick a new rate-limit bucket per request', async () => {
    const first = await resolvedIp(true, '10.0.0.5', '1.2.3.4');
    const second = await resolvedIp(true, '10.0.0.5', '5.6.7.8');

    expect(first).not.toBe(second);
  });
});
