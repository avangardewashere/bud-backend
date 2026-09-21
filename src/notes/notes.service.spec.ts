import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import { NotesService } from './notes.service.js';

/**
 * The deliverable URL guard, at the service rather than the request boundary.
 *
 * The request schema already rejects a bad scheme, so this looks redundant —
 * it is not. A deliverable is a link somebody clicks later, so a stored
 * `javascript:` URL is stored XSS aimed at whoever renders it, and the schema
 * only protects the one path that goes through an HTTP request. A script, an
 * import or an admin tool calling this service directly would bypass it.
 */

const course = {
  id: 'course-1',
  slug: 'docker-fundamentals',
  title: 'Docker',
  currentVersion: {
    sessions: [{ key: 's1', title: 'One', order: 1, deliverable: 'notes.md' }],
  },
};

function makeService() {
  const prisma = {
    course: { findFirst: vi.fn().mockResolvedValue(course) },
    enrollment: { findUnique: vi.fn().mockResolvedValue({ unenrolledAt: null }) },
    deliverable: {
      upsert: vi.fn().mockResolvedValue({
        sessionKey: 's1',
        url: 'https://example.com',
        comment: null,
        submittedAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    progressEvent: { create: vi.fn() },
  };

  return { service: new NotesService(prisma as unknown as PrismaService), prisma };
}

describe('NotesService deliverable URLs', () => {
  const dangerous = [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/looks-relative',
    'not a url at all',
  ];

  for (const url of dangerous) {
    it(`refuses ${url.slice(0, 32)}`, async () => {
      const { service, prisma } = makeService();

      await expect(
        service.saveDeliverable('user-1', 'docker-fundamentals', 's1', { url }),
      ).rejects.toThrow(/http or https/);

      // And nothing reached the database.
      expect(prisma.deliverable.upsert).not.toHaveBeenCalled();
    });
  }

  it('accepts http and https', async () => {
    for (const url of ['https://github.com/someone/repo', 'http://localhost:3000/preview']) {
      const { service, prisma } = makeService();

      await service.saveDeliverable('user-1', 'docker-fundamentals', 's1', { url });

      expect(prisma.deliverable.upsert).toHaveBeenCalled();
    }
  });

  it('refuses a link longer than the cap before looking at the scheme', async () => {
    const { service } = makeService();

    await expect(
      service.saveDeliverable('user-1', 'docker-fundamentals', 's1', {
        url: `https://example.com/${'x'.repeat(3000)}`,
      }),
    ).rejects.toThrow(/too long/);
  });
});
