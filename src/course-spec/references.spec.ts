import { describe, expect, it } from 'vitest';

import { packagePathsReferencedBy, storageKeysUsedIn } from './references.js';

/**
 * A scanner over author-written HTML, so the risk is not missing something —
 * it is crying wolf. Every finding it produces is a warning on a package that
 * works, and an author who is told twice about a file that is really there
 * stops reading the warnings. These cases are mostly about silence.
 */

describe('storageKeysUsedIn', () => {
  it('reads a literal argument', () => {
    const { keys, unresolved } = storageKeysUsedIn(`storage.set('course:one', '{}')`);

    expect([...keys]).toEqual(['course:one']);
    expect(unresolved).toBe(false);
  });

  it('follows the const the scaffolded template uses', () => {
    // `init` writes exactly this shape, so a scanner that only read literal
    // arguments would report every template-derived course as using no keys.
    const { keys } = storageKeysUsedIn(
      `const KEY = 'course:state';\nawait storage.set(KEY, JSON.stringify(state));`,
    );

    expect([...keys]).toEqual(['course:state']);
  });

  it('reads all three bridge calls, and through window', () => {
    const { keys } = storageKeysUsedIn(
      `storage.get("a"); window.storage.set('b', '1'); storage.delete(\`c\`);`,
    );

    expect([...keys].sort()).toEqual(['a', 'b', 'c']);
  });

  it('says so when a key is built at runtime rather than guessing', () => {
    const { keys, unresolved } = storageKeysUsedIn(
      "const prefix = 'course'; storage.set(`${prefix}:${id}`, '{}');",
    );

    expect([...keys]).toEqual([]);
    expect(unresolved).toBe(true);
  });

  it('finds nothing in a file that never touches storage', () => {
    const { keys, unresolved } = storageKeysUsedIn('<p>Just some prose.</p>');

    expect([...keys]).toEqual([]);
    expect(unresolved).toBe(false);
  });
});

describe('packagePathsReferencedBy', () => {
  it('resolves against the directory holding the file', () => {
    // The mistake this exists to catch: `assets/x.png` inside
    // `sessions/one.html` is `sessions/assets/x.png`, not `assets/x.png`.
    expect(packagePathsReferencedBy('sessions/one.html', '<img src="assets/x.png">')).toEqual([
      'sessions/assets/x.png',
    ]);
  });

  it('reads src, href, poster, srcset and CSS url()', () => {
    const found = packagePathsReferencedBy(
      'session.html',
      `<link href="style.css"><img src="a.png" srcset="a.png 1x, b@2x.png 2x">` +
        `<video poster="p.jpg"></video><style>body{background:url("bg.svg")}</style>`,
    );

    expect(found.sort()).toEqual(['a.png', 'b@2x.png', 'bg.svg', 'p.jpg', 'style.css']);
  });

  it('ignores anything that is not a path inside the package', () => {
    const found = packagePathsReferencedBy(
      'session.html',
      `<img src="https://example.test/a.png"><img src="//cdn.example.test/b.png">` +
        `<img src="data:image/gif;base64,R0lGOD"><a href="#top">t</a>` +
        `<a href="mailto:x@example.test">m</a><a href="/root.png">r</a>`,
    );

    expect(found).toEqual([]);
  });

  it('drops the query and the fragment, and decodes the path', () => {
    expect(packagePathsReferencedBy('session.html', '<img src="my%20cover.png?v=2#x">')).toEqual([
      'my cover.png',
    ]);
  });

  it('gives up on a reference that climbs out of the package', () => {
    // Nothing inside the archive can satisfy it, and the archive reader already
    // refuses `..` in entry names — so warning about it twice adds nothing.
    expect(packagePathsReferencedBy('session.html', '<img src="../outside.png">')).toEqual([]);
  });

  it('normalises . and redundant separators', () => {
    expect(packagePathsReferencedBy('sessions/one.html', '<img src="./pics//x.png">')).toEqual([
      'sessions/pics/x.png',
    ]);
  });

  it('counts each path once however many times it appears', () => {
    expect(
      packagePathsReferencedBy('s.html', '<img src="a.png"><img src="a.png"><img src="a.png">'),
    ).toEqual(['a.png']);
  });
});

describe('the scanner against input built to break it', () => {
  /**
   * A session is author-written and a package may be 50 MB, so "it is only our
   * own template" is not a defence — and this scanner runs on upload as well as
   * in the CLI.
   *
   * The bound is generous because a shared CI runner is noisy. It does not need
   * to be tight: the case it guards took **eighty seconds on four thousand
   * spaces** before `CSS_URL`'s unquoted branch was made non-empty and
   * whitespace-free. Anything still quadratic fails this by orders of
   * magnitude, which is the only resolution that matters.
   */
  const LIMIT_MS = 2_000;

  function timed(label: string, source: string) {
    const started = performance.now();
    storageKeysUsedIn(source);
    packagePathsReferencedBy('sessions/one.html', source);
    const ms = performance.now() - started;

    expect(ms, `${label} took ${ms.toFixed(0)}ms`).toBeLessThan(LIMIT_MS);
  }

  const N = 50_000;

  /**
   * Deliberately small for the `url(` cases, and the reason matters: a regex is
   * synchronous, so vitest cannot interrupt one. At 50,000 the old pattern
   * would not fail this bound — it would hang the run, and a hang in CI is a
   * six-hour job rather than a red test. At 4,000 it took eighty seconds, so
   * reintroducing it fails loudly and in bounded time. The linear cases below
   * keep the larger input because they are fast either way.
   */
  const N_URL = 4_000;

  it('survives url( followed by whitespace that never closes', () => {
    // The case that was quadratic twice over, each time for a different reason.
    timed('unclosed url(', `body { background: url(${' '.repeat(N_URL)}`);
  });

  it('survives many unclosed url( runs in one file', () => {
    timed('many unclosed url(', `url(${' '.repeat(200)}`.repeat(500));
  });

  it('survives an unterminated string after a const', () => {
    timed('unterminated const', `const KEY = "${'a'.repeat(N)}`);
  });

  it('survives alternating quotes and backslashes', () => {
    timed('quotes and backslashes', `const KEY = ${'"\\'.repeat(N / 2)}`);
  });

  it('survives an unterminated attribute value', () => {
    timed('unterminated attribute', `<img src="${'z'.repeat(N)}`);
  });

  it('survives a srcset with thousands of candidates', () => {
    timed('huge srcset', `<img srcset="${'a.png 1x, '.repeat(5_000)}">`);
  });

  it('still finds every shape of CSS url it should', () => {
    // The fix narrowed the unquoted branch, so this is the other half of it.
    for (const [css, expected] of [
      ['body{background:url("a.png")}', ['a.png']],
      ["body{background:url('b.png')}", ['b.png']],
      ['body{background:url(c.png)}', ['c.png']],
      ['body{background:url( d.png )}', ['d.png']],
      ['body{background:url(\n  e.png\n)}', ['e.png']],
      ['body{background:url(f.png?v=2#x)}', ['f.png']],
      // Names no file, so there is nothing to report.
      ['body{background:url()}', []],
    ] as [string, string[]][]) {
      expect(packagePathsReferencedBy('s.html', css), css).toEqual(expected);
    }
  });
});
