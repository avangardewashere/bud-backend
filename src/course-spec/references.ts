/**
 * What a session file refers to, read out of the file itself.
 *
 * Two questions the validator could not previously answer, both of which four
 * separate authors ran into on their first course:
 *
 *  - Which storage keys does this course actually use? A `storageKeys` list
 *    that disagrees with the sessions validated clean in both directions — an
 *    empty array, a typo, a key for a session that no longer exists.
 *  - Does every image a session points at exist in the package? A renamed file
 *    behind an `<img src>` validated clean and exit 0, while getting the
 *    *cover* path wrong produced a precise warning. The author who found it
 *    called that inconsistency the most surprising thing in the toolkit.
 *
 * This is deliberately a scanner and not a parser. A course session is a
 * document with author-written JavaScript in it, and anything that resolves
 * what that code *computes* is a second implementation of a browser. So it
 * reads what it can see literally, says when it saw something it could not
 * follow, and everything it reports is a warning — the validator's rule is that
 * warnings are things worth fixing and never reasons to refuse.
 */

/** `storage.get('x')`, `storage.set(KEY, …)`, `storage.delete(KEY)`. */
const STORAGE_CALL = /\bstorage\s*\.\s*(?:get|set|delete)\s*\(\s*([^,)]+)/g;

/** `const KEY = 'course:session'` — how the scaffolded template writes it. */
const STRING_CONST = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:[^'"\\]|\\.)*)\2/g;

/** A quoted string, whole and alone. */
const WHOLE_STRING = /^(['"])((?:[^'"\\]|\\.)*)\1$/;
/** A template literal with nothing interpolated is still a literal. */
const WHOLE_TEMPLATE = /^`([^`$]*)`$/;

export interface StorageKeyUse {
  /** Keys the file passes to the bridge, as far as they can be read literally. */
  keys: Set<string>;
  /**
   * True when a call's key could not be resolved — a template literal with an
   * expression in it, a function call, a property access. The report says so
   * rather than pretending the list is complete.
   */
  unresolved: boolean;
}

export function storageKeysUsedIn(source: string): StorageKeyUse {
  // Identifier → value, for the `const KEY = '…'` the template uses.
  const constants = new Map<string, string>();
  for (const match of source.matchAll(STRING_CONST)) {
    constants.set(match[1], match[3]);
  }

  const keys = new Set<string>();
  let unresolved = false;

  for (const match of source.matchAll(STORAGE_CALL)) {
    const argument = match[1].trim();

    const quoted = WHOLE_STRING.exec(argument) ?? WHOLE_TEMPLATE.exec(argument);
    if (quoted) {
      keys.add(quoted[2] ?? quoted[1]);
      continue;
    }

    const named = constants.get(argument);
    if (named !== undefined) {
      keys.add(named);
      continue;
    }

    unresolved = true;
  }

  return { keys, unresolved };
}

/** Schemes and shapes that name something outside the package. */
const NOT_A_PACKAGE_PATH = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

const SRC_OR_HREF = /\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*))\s*\)/gi;

/**
 * Every in-package path a file points at, resolved against the file's own
 * directory — `assets/x.png` inside `sessions/one.html` is
 * `sessions/assets/x.png`, which is the mistake this is most likely to catch.
 *
 * Absolute URLs, `data:`, `mailto:`, in-page anchors and protocol-relative URLs
 * are someone else's business. An external *script* is already an error
 * elsewhere; an external image is the author's choice.
 */
export function packagePathsReferencedBy(entryPath: string, source: string): string[] {
  const base = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
  const found = new Set<string>();

  const add = (raw: string | undefined) => {
    if (!raw) {
      return;
    }
    const value = raw.trim();
    if (value === '' || NOT_A_PACKAGE_PATH.test(value)) {
      return;
    }
    // A leading slash means the origin root, which is not the package root.
    if (value.startsWith('/')) {
      return;
    }

    const resolved = resolveAgainst(base, value);
    if (resolved !== null) {
      found.add(resolved);
    }
  };

  for (const match of source.matchAll(SRC_OR_HREF)) {
    add(match[1] ?? match[2]);
  }
  for (const match of source.matchAll(CSS_URL)) {
    add(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of source.matchAll(SRCSET)) {
    // `a.png 1x, b.png 2x` — the path is the first token of each candidate.
    for (const candidate of (match[1] ?? match[2] ?? '').split(',')) {
      add(candidate.trim().split(/\s+/)[0]);
    }
  }

  return [...found];
}

/**
 * Joins a reference onto the directory holding it, dropping the query and the
 * fragment. Returns null when the path climbs out of the package, which cannot
 * be checked against its contents and is broken anyway.
 */
function resolveAgainst(base: string, reference: string): string | null {
  const withoutSuffix = reference.split('#')[0].split('?')[0];
  if (withoutSuffix === '') {
    return null;
  }

  const segments = base === '' ? [] : base.split('/');

  for (const segment of withoutSuffix.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(decodeSegment(segment));
  }

  return segments.length === 0 ? null : segments.join('/');
}

/** `my%20cover.png` in the markup is `my cover.png` in the zip. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
