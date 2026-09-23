/**
 * How a path inside a course package is normalised before anything trusts it.
 *
 * Its own module, and not a private helper inside archive.ts, for two reasons:
 * the files a package is stored under and the URLs the catalog hands out have to
 * agree on one spelling — they did not, and a cover named `./assets/cover.png`
 * or `assets//cover.png` was stored one way and linked another — and because
 * archive.ts pulls in a zip reader that a URL builder has no business importing.
 */

/**
 * Normalises a package path and reports whether it tries to escape. Returns
 * null when the path is unsafe, which callers must treat as a refusal rather
 * than falling back to the raw value.
 */
export function normaliseEntryPath(raw: string): string | null {
  // Some writers emit backslashes; treat them as separators rather than
  // letting "a\..\..\b" slip past a forward-slash-only check.
  const unified = raw.replace(/\\/g, '/');

  if (unified.includes('\0')) {
    return null;
  }

  // Absolute, or a Windows drive letter.
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    return null;
  }

  const segments = unified.split('/');
  if (segments.some((s) => s === '..')) {
    return null;
  }

  // Drop "." segments and empty ones from doubled slashes.
  const cleaned = segments.filter((s) => s !== '.' && s !== '').join('/');

  return cleaned === '' ? null : cleaned;
}
