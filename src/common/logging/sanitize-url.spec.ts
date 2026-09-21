import { describe, expect, it } from 'vitest';

import { sanitizeUrl } from './sanitize-url.js';

describe('sanitizeUrl', () => {
  it('redacts an OAuth authorization code and state', () => {
    // The case that prompted this: a code is exchangeable for an access token
    // until it is used, and it was being written to every log line.
    const url = sanitizeUrl('/auth/github/callback?code=abc123&state=xyz789');

    expect(url).not.toContain('abc123');
    expect(url).not.toContain('xyz789');
    expect(url).toContain('code=[redacted]');
    expect(url).toContain('state=[redacted]');
  });

  it('keeps the parameter names, so a log still shows what was called', () => {
    expect(sanitizeUrl('/auth/github/callback?code=abc')).toBe(
      '/auth/github/callback?code=[redacted]',
    );
  });

  it('leaves ordinary query parameters alone', () => {
    // Losing ?cursor= and ?limit= would make list endpoints undebuggable, to
    // protect a parameter that is usually not there.
    const url = '/courses?cursor=01a0b365-ed52&limit=20';

    expect(sanitizeUrl(url)).toBe(url);
  });

  it('redacts only the secret among several parameters', () => {
    const url = sanitizeUrl('/x?limit=20&token=sekrit&cursor=abc');

    expect(url).toBe('/x?limit=20&token=[redacted]&cursor=abc');
  });

  it('is case-insensitive about parameter names', () => {
    expect(sanitizeUrl('/x?CODE=abc&State=def')).toBe('/x?CODE=[redacted]&State=[redacted]');
  });

  it('leaves a URL with no query string untouched', () => {
    expect(sanitizeUrl('/me/dashboard')).toBe('/me/dashboard');
  });

  it('passes through a malformed query rather than rewriting it', () => {
    // A flag with no value tells you something about the caller; silently
    // normalising it away would hide it.
    expect(sanitizeUrl('/x?standalone&limit=5')).toBe('/x?standalone&limit=5');
  });

  it('does not redact a course state key, which is not a secret', () => {
    // These are in the path rather than the query, but worth pinning: they are
    // how you work out which key a learner was writing when something failed.
    const url = '/me/courses/docker-fundamentals/state/docker-course%3Astate';

    expect(sanitizeUrl(url)).toBe(url);
  });
});
