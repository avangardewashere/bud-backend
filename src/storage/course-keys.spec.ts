import { describe, expect, it } from 'vitest';

import { isCoursePath } from '../course-serving/courses-server.js';
import {
  courseContentPath,
  courseContentUrl,
  courseCoverUrl,
  courseStoragePrefix,
} from './course-keys.js';

/**
 * The bug these exist to stop coming back: a cover URL built by pasting the
 * storage key onto the courses origin, which produced
 * `…/courses/docker-fundamentals/1.0.0/cover.png` — a path whose second segment
 * is a slug where the content router requires a version, so every cover was a
 * broken image. The test that matters is the last one: the URL this module
 * hands out has to be a path the router will actually serve.
 */
describe('course storage keys and content URLs', () => {
  const key = `${courseStoragePrefix('docker-fundamentals', '1.0.0')}/assets/cover.png`;

  it('namespaces stored files under the bucket prefix', () => {
    expect(key).toBe('courses/docker-fundamentals/1.0.0/assets/cover.png');
  });

  it('drops the bucket namespace from the public path', () => {
    expect(courseContentPath(key)).toBe('/docker-fundamentals/1.0.0/assets/cover.png');
  });

  it('builds an absolute URL on the courses origin', () => {
    expect(courseContentUrl('http://127.0.0.1:3101', key)).toBe(
      'http://127.0.0.1:3101/docker-fundamentals/1.0.0/assets/cover.png',
    );
  });

  it('does not double the slash when the origin carries one', () => {
    // COURSES_ORIGIN is validated as a URL, and `https://host/` is a valid one.
    expect(courseContentUrl('https://courses.example/', key)).toBe(
      'https://courses.example/docker-fundamentals/1.0.0/assets/cover.png',
    );
  });

  it.each(['notes/user-1/whatever.md', 'courses', 'courses/', ''])(
    'has no public URL for a key that is not course content: %s',
    (stray) => {
      expect(courseContentPath(stray)).toBeNull();
      expect(courseContentUrl('https://courses.example', stray)).toBeNull();
    },
  );

  it('produces a path the content router accepts', () => {
    // The whole point. If these two ever disagree again, the cover 404s.
    const url = courseContentUrl('https://courses.example', key);

    expect(url).not.toBeNull();
    expect(isCoursePath(new URL(url!).pathname)).toBe(true);
  });

  it('would have failed for the key handed out as a URL', () => {
    // What the old code built, kept as the record of what went wrong.
    expect(isCoursePath(`/${key}`)).toBe(false);
  });
});

/**
 * Three ways the cover went missing again after the path shape was fixed, all
 * found by review rather than by use — no course in the repo has a cover, so
 * none of this shows up in a normal run.
 */
describe('the cover URL for a published version', () => {
  const version = (storagePrefix: string, cover: unknown) => ({
    storagePrefix,
    manifest: { id: 'docker-fundamentals', cover },
  });

  it('follows the version being served, not the newest upload', () => {
    // A column on the course followed uploads: publishing stayed on 1.0.0 while
    // the cover moved to a 1.1.0 draft the content origin will not serve.
    expect(
      courseCoverUrl(
        'https://courses.example',
        version('courses/docker-fundamentals/1.0.0', 'assets/cover.png'),
      ),
    ).toBe('https://courses.example/docker-fundamentals/1.0.0/assets/cover.png');
  });

  it.each([
    ['./assets/cover.png', 'assets/cover.png'],
    ['assets//cover.png', 'assets/cover.png'],
    ['assets\\cover.png', 'assets/cover.png'],
  ])('spells the path the way the file was stored: %s', (declared, stored) => {
    // The validator accepts all of these; the archive stored every one of them
    // under the cleaned path, so linking the raw spelling pointed at nothing.
    expect(courseCoverUrl('https://courses.example', version('courses/c/1.0.0', declared))).toBe(
      `https://courses.example/c/1.0.0/${stored}`,
    );
  });

  it.each([null, undefined, '', '   ', 42, '../../etc/passwd', '/etc/passwd'])(
    'has no URL for a cover of %s',
    (cover) => {
      expect(
        courseCoverUrl('https://courses.example', version('courses/c/1.0.0', cover)),
      ).toBeNull();
    },
  );

  it('has no URL when the course has no published version at all', () => {
    expect(courseCoverUrl('https://courses.example', null)).toBeNull();
    expect(courseCoverUrl('https://courses.example', undefined)).toBeNull();
  });
});

/**
 * A file name is a literal; a URL is not. The router decodes what it receives,
 * so anything the validator lets through has to survive the round trip.
 */
describe('names that need escaping', () => {
  it.each([
    ['assets/cover#1.png', 'assets/cover%231.png'],
    ['assets/cover?x.png', 'assets/cover%3Fx.png'],
    ['assets/100% off.png', 'assets/100%25%20off.png'],
    ['assets/cover%20a.png', 'assets/cover%2520a.png'],
    ['assets/a&b.png', 'assets/a%26b.png'],
  ])('encodes %s', (stored, encoded) => {
    const key = `${courseStoragePrefix('c', '1.0.0')}/${stored}`;

    expect(courseContentPath(key)).toBe(`/c/1.0.0/${encoded}`);
    // Unencoded, `#` truncated the path at the fragment and `%` made the whole
    // URL invalid — both fetch something other than the file.
    expect(decodeURIComponent(new URL(courseContentUrl('https://c.example', key)!).pathname)).toBe(
      `/c/1.0.0/${stored}`,
    );
  });

  it('leaves an ordinary name alone', () => {
    expect(courseContentPath('courses/c/1.0.0/assets/cover.png')).toBe('/c/1.0.0/assets/cover.png');
  });
});
