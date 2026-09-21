/**
 * Query parameters that must never reach a log line.
 *
 * Logs travel further than the database: they go to aggregators, to dashboards,
 * to whoever is on call, and often to a third party. A request URL looks
 * harmless until an OAuth flow puts a one-time credential in it.
 *
 * `code` is the authorization code, exchangeable for an access token until it
 * is used. `state` is the CSRF token for that exchange. The rest are here
 * because if they ever appear in a query string, the same reasoning applies.
 */
const SECRET_PARAMS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'secret',
  'password',
  'invite',
  'invitetoken',
  'key_secret',
]);

const REDACTED = '[redacted]';

/**
 * Replaces the values of sensitive query parameters, keeping the names so a log
 * still shows the shape of the request that was made.
 *
 * Deliberately not dropping the whole query string: `?cursor=` and `?limit=`
 * are how you work out why a list endpoint behaved oddly, and losing them to
 * protect a parameter that is usually absent is a bad trade.
 */
export function sanitizeUrl(url: string): string {
  const queryAt = url.indexOf('?');
  if (queryAt === -1) {
    return url;
  }

  const path = url.slice(0, queryAt);
  const query = url.slice(queryAt + 1);

  // Hand-rolled rather than URLSearchParams so the output preserves the
  // original ordering and separators, and so a malformed query string is
  // passed through rather than silently rewritten.
  const sanitized = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) {
        return pair;
      }

      const name = pair.slice(0, eq);
      return SECRET_PARAMS.has(name.toLowerCase()) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');

  return `${path}?${sanitized}`;
}
