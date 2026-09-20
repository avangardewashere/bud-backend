/**
 * Content types for the extensions the course spec allows.
 *
 * Deliberately free of any Nest or config import: this is a pure lookup, and
 * the course-content server needs it without dragging in the DI graph — which
 * would validate the environment at import time and make it unusable from a
 * unit test.
 *
 * Course HTML is served to a browser, so guessing wrong here is a rendering bug
 * at best and a sniffing problem at worst.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
};

/** `application/octet-stream` means "not a type a course may contain". */
export function contentTypeFor(path: string): string {
  const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
