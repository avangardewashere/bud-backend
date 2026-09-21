import { beforeAll, describe, expect, it } from 'vitest';

import { API_BASE, ApiClient, apiIsUp, ensureTestUser } from './client.js';

/**
 * Notes and deliverables — what the Docker course already asks every learner to
 * produce, now held by the platform.
 */

const EMAIL = 'e2e-notes@bud.local';
const PASSWORD = 'e2e-notes-password-123';
const SLUG = 'docker-fundamentals';

interface Note {
  sessionKey: string;
  sessionTitle: string | null;
  sessionOrder: number | null;
  bodyMd: string;
  updatedAt: string;
}

interface Deliverable {
  sessionKey: string;
  asked: string | null;
  url: string;
  comment: string | null;
  submittedAt: string | null;
}

interface ErrorBody {
  statusCode: number;
  code: string;
}

const up = await apiIsUp();

describe.skipIf(!up)('notes', () => {
  const api = new ApiClient();
  const note = (key: string) => `/me/courses/${SLUG}/sessions/${key}/notes`;

  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
    await api.login(EMAIL, PASSWORD);
    await api.post(`/courses/${SLUG}/enroll`);
  });

  it('returns null for a session with no note, rather than 404', async () => {
    const response = await api.get<Note | null>(note('s1'));

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('saves a note and reads back exactly what was written', async () => {
    const bodyMd = '# Session 1\n\nAn image is a *template*; a container is a running one.\n';

    const saved = await api.put<Note>(note('s1'), { bodyMd });
    expect(saved.status).toBe(200);
    expect(saved.body.bodyMd).toBe(bodyMd);

    const read = await api.get<Note>(note('s1'));
    expect(read.body.bodyMd).toBe(bodyMd);
  });

  it('carries the session title, so a note can be shown against its session', async () => {
    const read = await api.get<Note>(note('s1'));

    expect(read.body.sessionTitle).toBe('The container mental model');
    expect(read.body.sessionOrder).toBe(1);
  });

  it('overwrites rather than appending', async () => {
    await api.put(note('s2'), { bodyMd: 'first' });
    await api.put(note('s2'), { bodyMd: 'second' });

    const read = await api.get<Note>(note('s2'));
    expect(read.body.bodyMd).toBe('second');
  });

  it('deletes the note when the body is cleared', async () => {
    await api.put(note('s3'), { bodyMd: 'written then cleared' });
    const cleared = await api.put<Note | null>(note('s3'), { bodyMd: '   ' });

    // Storing emptiness would keep an empty heading in the export forever.
    expect(cleared.body).toBeNull();
    expect((await api.get<Note | null>(note('s3'))).body).toBeNull();
  });

  it('refuses a note larger than the cap', async () => {
    const response = await api.put<ErrorBody>(note('s4'), {
      bodyMd: 'x'.repeat(256 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('storage_value_too_large');
  });

  it('refuses a session the course does not have', async () => {
    const response = await api.put<ErrorBody>(note('s99'), { bodyMd: 'nowhere' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('unknown_session');
  });

  it('lists notes in session order, omitting sessions with none', async () => {
    const response = await api.get<Note[]>(`/me/courses/${SLUG}/notes`);

    expect(response.status).toBe(200);
    const keys = response.body.map((n) => n.sessionKey);
    expect(keys).toContain('s1');
    expect(keys).toContain('s2');
    // s3 was cleared, so it is absent rather than present and empty.
    expect(keys).not.toContain('s3');
    // Session order, not write order: s2 was written after s1 was last touched.
    expect(keys).toEqual([...keys].sort());
  });

  it('is private to the learner who wrote it', async () => {
    const stranger = new ApiClient();
    await ensureTestUser('e2e-notes-stranger@bud.local', PASSWORD);
    await stranger.login('e2e-notes-stranger@bud.local', PASSWORD);

    const response = await stranger.get<ErrorBody>(note('s1'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('not_enrolled');
  });

  describe('export', () => {
    it('returns one markdown document, as a download', async () => {
      // Not through ApiClient: this response is markdown, not JSON.
      const response = await fetch(`${API_BASE}/me/courses/${SLUG}/notes/export`, {
        headers: { cookie: (api as unknown as { cookie: string }).cookie },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/markdown/);
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(response.headers.get('content-disposition')).toContain('docker-fundamentals-notes.md');

      const markdown = await response.text();
      expect(markdown).toContain('# Docker: 10-Session Course — notes');
      expect(markdown).toContain('## 1. The container mental model');
      expect(markdown).toContain('An image is a *template*');
      // A cleared note leaves no empty heading behind.
      expect(markdown).not.toContain('## 3.');
    });

    it('keeps one outline, and does not rewrite shell comments', async () => {
      // Built from an array so there is nothing to escape: the point of the
      // test is the fenced block, and a mangled fence would test nothing.
      const bodyMd = [
        '# My own heading',
        '',
        '```bash',
        '# rebuild the image',
        'docker build .',
        '```',
      ].join('\n');

      await api.put(`/me/courses/${SLUG}/sessions/s6/notes`, { bodyMd });

      const response = await fetch(`${API_BASE}/me/courses/${SLUG}/notes/export`, {
        headers: { cookie: (api as unknown as { cookie: string }).cookie },
      });
      const markdown = await response.text();

      // The note's own H1 sits beneath the session heading rather than
      // competing with the document title.
      expect(markdown).toContain('### My own heading');
      // But a # inside a fence is a shell comment, and rewriting it would
      // corrupt the command the learner wrote down.
      expect(markdown).toContain('# rebuild the image');
      expect(markdown).not.toContain('### rebuild the image');

      // Exactly one H1: the document title. Counted outside code fences,
      // because `# rebuild the image` inside a bash block is a comment — the
      // same trap the export itself has to avoid, and a naive line regex here
      // walked straight into it.
      let inFence = false;
      const h1s = markdown.split('\n').filter((line) => {
        if (/^\s{0,3}(```|~~~)/.test(line)) {
          inFence = !inFence;
          return false;
        }
        return !inFence && /^# /.test(line);
      });
      expect(h1s).toHaveLength(1);
    });
  });
});

describe.skipIf(!up)('deliverables', () => {
  const api = new ApiClient();
  const deliverable = (key: string) => `/me/courses/${SLUG}/sessions/${key}/deliverable`;

  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
    await api.login(EMAIL, PASSWORD);
    await api.post(`/courses/${SLUG}/enroll`);
  });

  it('submits a link and marks it submitted by default', async () => {
    const response = await api.put<Deliverable>(deliverable('s1'), {
      url: 'https://github.com/someone/docker-session-1',
      comment: 'nginx running in a container',
    });

    expect(response.status).toBe(200);
    expect(response.body.submittedAt).not.toBeNull();
  });

  it('shows what the manifest asked for beside what was handed in', async () => {
    const response = await api.get<Deliverable[]>(`/me/courses/${SLUG}/deliverables`);

    const s1 = response.body.find((d) => d.sessionKey === 's1');
    // Straight from the course manifest, so the UI can show the ask and the answer.
    expect(s1?.asked).toContain('notes.md');
  });

  it('retracts without losing the link', async () => {
    const response = await api.put<Deliverable>(deliverable('s1'), {
      url: 'https://github.com/someone/docker-session-1',
      submitted: false,
    });

    expect(response.body.submittedAt).toBeNull();
    expect(response.body.url).toBe('https://github.com/someone/docker-session-1');
  });

  it('refuses a URL that is not http or https', async () => {
    // A javascript: or data: URL here is stored XSS waiting for whatever renders it.
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const response = await api.put<ErrorBody>(deliverable('s2'), { url });
      expect(response.status).toBe(400);
    }
  });

  it('refuses a session the course does not have', async () => {
    const response = await api.put<ErrorBody>(deliverable('s99'), {
      url: 'https://example.com',
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('unknown_session');
  });

  it('deletes a deliverable entirely', async () => {
    await api.put(deliverable('s5'), { url: 'https://example.com/doomed' });

    const removed = await api.delete(deliverable('s5'));
    expect(removed.status).toBe(204);

    const list = await api.get<Deliverable[]>(`/me/courses/${SLUG}/deliverables`);
    expect(list.body.map((d) => d.sessionKey)).not.toContain('s5');
  });
});
