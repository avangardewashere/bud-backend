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
