import { MANIFEST_FIELDS, SESSION_FIELDS } from './manifest.schema.js';

/**
 * "You wrote `description`; this format calls it `summary`."
 *
 * The validator already knew both halves of that and reported them as two
 * unrelated problems — one unrecognised key, one missing required field — which
 * an author hand-writing their first manifest has to join up for themselves.
 * The first person to try it rated that the second-worst thing in the toolkit,
 * behind only the absence of any field reference at all.
 *
 * Two sources, in order of confidence: a small table of names other formats use
 * for the same thing, then an edit-distance match against the field names for
 * that level of the manifest. The table exists because `description` is not one
 * typo away from `summary` — it is a different word for the same idea, and no
 * amount of string distance finds it.
 */
const ALIASES: Record<string, string> = {
  // Other course formats, and plain English for the same field.
  description: 'summary',
  abstract: 'summary',
  blurb: 'summary',
  file: 'entry',
  path: 'entry',
  href: 'entry',
  url: 'entry',
  src: 'entry',
  name: 'title',
  heading: 'title',
  label: 'title',
  slug: 'id',
  key: 'id',
  identifier: 'id',
  index: 'order',
  position: 'order',
  sort: 'order',
  difficulty: 'level',
  duration: 'estimatedHours',
  hours: 'estimatedHours',
  length: 'estimatedHours',
  time: 'estimatedHours',
  keywords: 'tags',
  topics: 'tags',
  categories: 'tags',
  image: 'cover',
  thumbnail: 'cover',
  banner: 'cover',
  contents: 'outline',
  toc: 'outline',
  syllabus: 'outline',
  lessons: 'sessions',
  chapters: 'sessions',
  modules: 'sessions',
  units: 'sessions',
  colour: 'theme',
  color: 'theme',
  accent: 'theme',
};

/**
 * What to suggest for a key the manifest does not recognise, or undefined when
 * there is nothing honest to say. `at` is the failing schema path, so a key
 * inside `sessions[2]` is matched against a session's fields rather than the
 * course's.
 */
export function suggestFieldFor(unknownKey: string, at: string): string | undefined {
  const fields = at.startsWith('sessions') ? SESSION_FIELDS : MANIFEST_FIELDS;
  const lower = unknownKey.toLowerCase();

  const alias = ALIASES[lower];
  if (alias && fields.includes(alias)) {
    return alias;
  }

  // A typo, rather than a different word: allow one edit for short names and
  // two for longer ones, and never guess from a distance that could match
  // several fields equally badly.
  let best: { field: string; distance: number } | undefined;
  for (const field of fields) {
    const distance = editDistance(lower, field.toLowerCase());
    if (best === undefined || distance < best.distance) {
      best = { field, distance };
    }
  }

  const allowed = lower.length <= 4 ? 1 : 2;
  return best && best.distance <= allowed ? best.field : undefined;
}

/** Levenshtein, two rows. Field names are short; this is not a hot path. */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length];
}
