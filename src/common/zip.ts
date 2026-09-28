import { Buffer } from 'node:buffer';
import yazl from 'yazl';

/**
 * Making a zip in memory.
 *
 * Extracted because there are now two reasons to build one — packaging a course
 * and exporting a learner's data — and the fiddly part is the same both times:
 * yazl is a stream, so "give me the bytes" is a promise nobody should write
 * twice.
 */

export interface ZipEntry {
  /** Always forward-slashed: that is what a zip entry name is, on every OS. */
  path: string;
  content: Buffer | string;
}

/**
 * A fixed timestamp for every entry, so the same input twice produces the same
 * bytes. The zip format stores local time with no zone, so this is deliberately
 * a round number in UTC rather than anything meaningful.
 */
export const FIXED_MTIME = new Date('2020-01-01T00:00:00.000Z');

export interface ZipOptions {
  /** Leave unset for reproducible output; pass a date when the time matters. */
  mtime?: Date;
}

export function zipFiles(entries: ZipEntry[], options: ZipOptions = {}): Promise<Buffer> {
  const zip = new yazl.ZipFile();

  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content), entry.path, {
      mtime: options.mtime ?? FIXED_MTIME,
      mode: 0o100644,
    });
  }

  zip.end();

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
