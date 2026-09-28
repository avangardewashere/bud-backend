import { Buffer } from 'node:buffer';
import { beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';

import { API_BASE, ApiClient, apiIsUp, ensureTestUser } from './client.js';

/**
 * `GET /me/export` over real HTTP, because the thing worth checking is the file
 * a learner actually receives: a zip their operating system will open, with
 * their work inside it.
 *
 * The scoping — that it holds one learner's data and no one else's — is tested
 * against a two-learner database in export.service.spec.ts. This is about the
 * download.
 */

const EMAIL = 'e2e-export@bud.local';
const PASSWORD = 'e2e-export-password-123';
const SLUG = 'docker-fundamentals';
/** What a worksheet would have saved: its own JSON, as a string. */
const SAVED_BLOB = JSON.stringify({ ticked: ['one', 'two'] });

const up = await apiIsUp();

/** Entry names mapped to contents. */
async function unzip(archive: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('not a zip'));
        return;
      }

      const files = new Map<string, string>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('unreadable entry'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe.skipIf(!up)('exporting everything you own', () => {
  const api = new ApiClient();
  let files: Map<string, string>;
  let disposition: string | null;

  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
    await api.login(EMAIL, PASSWORD);
    await api.post(`/courses/${SLUG}/enroll`);

    const detail = await api.get<{ sessions: { key: string }[] }>(`/courses/${SLUG}`);
    const key = detail.body.sessions[0].key;

    // Something of each kind, so the export has work to hold. Each response is
    // checked: a setup step that quietly failed would leave this suite asserting
    // that an empty export is correct — which is exactly what it did at first,
    // when the state write was sending an object where the bridge sends a string.
    const setup = [
      await api.post(`/me/courses/${SLUG}/sessions/${key}/open`),
      await api.put(`/me/courses/${SLUG}/sessions/${key}/notes`, {
        bodyMd: '# Session 1\n\nA note that has to survive the round trip.',
      }),
      await api.put(`/me/courses/${SLUG}/sessions/${key}/deliverable`, {
        url: 'https://github.com/example/e2e-export',
      }),
      await api.put(`/me/courses/${SLUG}/state/docker-course:state`, { value: SAVED_BLOB }),
    ];
    expect(setup.map((response) => response.status)).toEqual([200, 200, 200, 204]);

    // Not through ApiClient: this response is a zip, and text() would corrupt it.
    const response = await fetch(`${API_BASE}/me/export`, {
      headers: { cookie: (api as unknown as { cookie: string }).cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/zip/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    disposition = response.headers.get('content-disposition');

    files = await unzip(Buffer.from(await response.arrayBuffer()));
  });

  it('downloads as a zip named for the day it was taken', () => {
    expect(disposition).toContain('attachment');
    expect(disposition).toMatch(/bud-export-\d{4}-\d{2}-\d{2}\.zip/);
  });

  it('is a real archive with the three things it promises', () => {
    expect([...files.keys()].sort()).toEqual(
      ['README.md', `notes/${SLUG}.md`, 'bud-export.json'].sort(),
    );
  });

  it('holds the work that only Bud has a copy of', () => {
    const data = JSON.parse(files.get('bud-export.json')!) as {
      spec: string;
      you: { email: string };
      courses: {
        slug: string;
        notes: { bodyMd: string }[];
        deliverables: { url: string }[];
        savedWork: { key: string; value: unknown }[];
        sessions: { sessionKey: string }[];
      }[];
      activity: { type: string }[];
    };

    expect(data.spec).toBe('bud-export/1');
    expect(data.you.email).toBe(EMAIL);

    const course = data.courses.find((c) => c.slug === SLUG)!;
    expect(course.notes[0].bodyMd).toContain('survive the round trip');
    expect(course.deliverables[0].url).toBe('https://github.com/example/e2e-export');
    // The blob the worksheet itself saved, back out of the database byte for byte.
    expect(course.savedWork).toEqual([
      expect.objectContaining({ key: 'docker-course:state', value: SAVED_BLOB }),
    ]);
    expect(course.sessions.length).toBeGreaterThan(0);
    expect(data.activity.length).toBeGreaterThan(0);
  });

  it('carries no password hash and no session token', () => {
    // They are credentials, not records. An export that leaked either would turn
    // a file people email themselves into a way into the account.
    const whole = [...files.values()].join('\n');

    expect(whole).not.toMatch(/\$argon2/);
    expect(whole).not.toContain(PASSWORD);
    expect(whole).not.toMatch(/passwordHash/i);
    expect(whole).not.toMatch(/bud_session/);
  });

  it('refuses without a session', async () => {
    const response = await fetch(`${API_BASE}/me/export`);

    expect(response.status).toBe(401);
  });
});
