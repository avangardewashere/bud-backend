import { z } from 'zod';

import { DEFAULT_ARCHIVE_LIMITS } from './archive.js';
import { ALLOWED_EXTENSIONS } from './course-spec.service.js';
import { MANIFEST_FILENAME, manifestSchema } from './manifest.schema.js';
import { VALIDATION_CODES } from './validation.types.js';

/**
 * The machine-readable course spec: the manifest's JSON Schema, the archive
 * limits, the extensions a package may contain and every validation code.
 *
 * Built here rather than in the controller because it is not only an HTTP
 * resource. `GET /course-spec/schema` serves it, and `bud-course spec` prints
 * it — which is the whole point: the README promises that authoring "needs no
 * database, no environment and no running Bud", and until this existed the only
 * description of the manifest was behind an endpoint. Every author who tried
 * reverse-engineered the field names from validation errors instead, one guess
 * per round trip.
 *
 * Generated once. The schema cannot change at runtime.
 */
export const courseSpecDocument = (() => {
  const document = {
    spec: 'bud-course/1',
    manifestFilename: MANIFEST_FILENAME,
    schema: z.toJSONSchema(manifestSchema, { io: 'input', target: 'draft-2020-12' }),
    limits: {
      maxArchiveBytes: DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes,
      maxTotalUncompressedBytes: DEFAULT_ARCHIVE_LIMITS.maxTotalUncompressedBytes,
      maxEntries: DEFAULT_ARCHIVE_LIMITS.maxEntries,
    },
    allowedExtensions: [...ALLOWED_EXTENSIONS].sort(),
    // Published so a panel can key its hints off codes it knows about and
    // degrade gracefully for ones added later.
    validationCodes: [...VALIDATION_CODES],
  };

  return () => document;
})();

export type CourseSpecDocument = ReturnType<typeof courseSpecDocument>;
