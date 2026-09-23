/**
 * How much of a course's estimated hours a learner has done.
 *
 * A manifest gives one number for the whole course (`estimatedHours`) and a
 * weight per session — light, medium or heavy (§4). Counting sessions would
 * make three light ones worth as much as three heavy ones, so the hours are
 * split by weight instead, and a session with no weight counts as medium.
 *
 * It is an estimate the author made, not measured time: nothing here claims
 * the learner spent those hours, only that this much of the course is behind
 * them. Real time on page is a Phase 2 item that needs the player to report it.
 */

/** Relative effort. Ratios only — the total is whatever the manifest says. */
const WEIGHTS: Record<string, number> = { light: 1, medium: 2, heavy: 3 };
const DEFAULT_WEIGHT = WEIGHTS.medium;

export interface WeightedSession {
  key: string;
  weight: string | null;
}

export interface EstimatedHours {
  /** What the author estimated for the whole course, or null if they did not say. */
  total: number | null;
  /** The share of it behind the learner, rounded to a tenth. Null when total is. */
  completed: number | null;
}

const weightOf = (session: WeightedSession) =>
  (session.weight === null ? undefined : WEIGHTS[session.weight]) ?? DEFAULT_WEIGHT;

export function estimatedHours(
  sessions: readonly WeightedSession[],
  completedKeys: ReadonlySet<string>,
  courseHours: number | null,
): EstimatedHours {
  if (courseHours === null || sessions.length === 0) {
    return { total: courseHours, completed: courseHours === null ? null : 0 };
  }

  const total = sessions.reduce((sum, session) => sum + weightOf(session), 0);
  const done = sessions
    .filter((session) => completedKeys.has(session.key))
    .reduce((sum, session) => sum + weightOf(session), 0);

  return {
    total: courseHours,
    // A tenth of an hour is as precise as an estimate deserves to be shown.
    completed: Math.round(courseHours * (done / total) * 10) / 10,
  };
}

/** Course totals added up, ignoring courses whose author gave no estimate. */
export function sumEstimatedHours(all: readonly EstimatedHours[]): {
  total: number;
  completed: number;
} {
  const round = (n: number) => Math.round(n * 10) / 10;

  return {
    total: round(all.reduce((sum, hours) => sum + (hours.total ?? 0), 0)),
    completed: round(all.reduce((sum, hours) => sum + (hours.completed ?? 0), 0)),
  };
}
