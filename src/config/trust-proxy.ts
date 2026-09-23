/**
 * Which addresses in `X-Forwarded-For` the API is allowed to believe.
 *
 * `trustProxy: true` — what this used to be — believes the *leftmost* address in
 * the header, and the leftmost address is whatever the caller typed. Every
 * defence keyed on who is calling is then one header away from nothing: a fresh
 * address per request is a fresh rate-limit bucket and a fresh allowance of
 * failed sign-ins, and the address stored on a session record is fiction. On a
 * free tier that also means a stranger can spend the month's compute hours at
 * will.
 *
 * So name the proxies instead of trusting all of them. Fastify hands this to
 * proxy-addr, which walks outward from the socket through the forwarded chain
 * and stops at the first address that is not one of ours — the real caller,
 * whatever they wrote in front of it.
 *
 * **A hop count is not an option here**, however much the Express documentation
 * suggests one: Fastify 5 reads a number as *trust nothing*, deliberately
 * ("hop-count-only trust cannot validate the immediate peer"), so `TRUST_PROXY=1`
 * would look configured while quietly putting every caller in a single bucket.
 * Boot refuses a number rather than letting that pass unnoticed.
 *
 * Parsed here rather than in env.schema.ts, alone among the settings: the
 * Fastify adapter is constructed as an argument to NestFactory.create, before
 * AppConfigService exists to be injected. So this reads process.env directly and
 * validates itself, and boot still fails on a bad value.
 *
 * It is still *declared* in env.schema.ts, and must be: ConfigModule writes only
 * what the validator returns back into process.env, and a Zod object strips
 * everything it does not declare. Without the declaration a TRUST_PROXY in .env
 * vanished before this function ever saw it — the override did nothing and a hop
 * count no longer failed boot, which is exactly the silent misconfiguration
 * below.
 */

/**
 * Trust a reverse proxy reaching us over loopback or a private network, and
 * nothing else. Correct for every arrangement Bud actually ships in — Caddy on
 * the same host, Compose, Render behind its router — and never satisfiable by a
 * caller from the public internet.
 *
 * Where it is wrong it fails closed: an untrusted peer means the forwarded chain
 * is ignored and every caller is seen as the proxy, which is coarse rate
 * limiting rather than none.
 *
 * The one case to override it for is a deploy where callers' own addresses are
 * private — a LAN install with no proxy in front. Their address is then inside
 * this trust, so the header they send in front of it is believed. Name the
 * proxy's address outright there.
 */
const DEFAULT = 'loopback,uniquelocal';

export type TrustProxy = boolean | string[];

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = (raw ?? '').trim() || DEFAULT;

  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    throw new Error(
      `TRUST_PROXY=${value} is a hop count, which Fastify reads as "trust no proxy at all" — ` +
        'every caller would look like the proxy in front of them. Name the proxies instead: ' +
        `a comma-separated list of addresses, CIDR ranges or the presets loopback, linklocal and ` +
        `uniquelocal (the default is "${DEFAULT}"). Use true only to trust any caller's ` +
        'X-Forwarded-For, which is spoofable.',
    );
  }

  const addresses = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (addresses.length === 0) {
    throw new Error('TRUST_PROXY lists no addresses. Leave it unset for the default.');
  }

  return addresses;
}
