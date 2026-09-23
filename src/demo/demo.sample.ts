/**
 * What the demo learner has "already done" when a visitor arrives.
 *
 * A portfolio visitor should land on a dashboard that looks lived in: a course
 * part-finished, a streak running, notes written, something handed in. An
 * empty account shows none of the product, and inventing it in the UI would be
 * a lie the API cannot back up — so it is real data, written to the demo
 * account and thrown away again.
 *
 * Pure on purpose: what the plan contains is a product decision worth reading
 * and testing, separate from the rows it becomes.
 */

export interface DemoNote {
  sessionIndex: number;
  bodyMd: string;
}

export interface DemoEvent {
  /** 0 is today, 1 is yesterday — in the demo account's timezone (UTC). */
  daysAgo: number;
  type: 'session.opened' | 'session.completed';
  sessionIndex: number;
}

export interface DemoPlan {
  /** Sessions finished, by position in the course. */
  completed: number[];
  /** The one in progress, which the continue card points at. */
  inProgress: { sessionIndex: number; fraction: number } | null;
  enrolledDaysAgo: number;
  notes: DemoNote[];
  deliverable: { sessionIndex: number; url: string; comment: string } | null;
  /** Backdated, so the heatmap and the streak have something to show. */
  events: DemoEvent[];
}

/**
 * Three days in a row up to today, a five-day run a fortnight back, and gaps
 * between: a streak worth showing, a longest that is not the current one, and
 * a heatmap that is not a solid block.
 */
const ACTIVE_DAYS = [0, 1, 2, 5, 6, 9, 10, 11, 12, 13];

const NOTES = [
  'Containers are just processes with their own view of the filesystem.\n\n' +
    'The `--rm` flag is the one I keep forgetting; without it every run leaves a stopped container behind.',
  'Layers are cached by instruction, so the order in a Dockerfile is a performance decision:\n\n' +
    '- copy `package.json` first\n- install\n- *then* copy the source\n\n' +
    'Otherwise every source edit reinstalls everything.',
];

/**
 * The plan, fitted to however many sessions the course actually has. A course
 * with three sessions must not produce a demo claiming five are finished.
 */
export function demoPlan(sessionCount: number): DemoPlan {
  if (sessionCount === 0) {
    return {
      completed: [],
      inProgress: null,
      enrolledDaysAgo: 0,
      notes: [],
      deliverable: null,
      events: [],
    };
  }

  // Roughly a third done: far enough in to look real, with plenty left to show.
  const completed = Array.from({ length: Math.min(3, Math.max(1, Math.floor(sessionCount / 3))) })
    .map((_, index) => index)
    .filter((index) => index < sessionCount);

  const nextIndex = completed.length;
  const inProgress = nextIndex < sessionCount ? { sessionIndex: nextIndex, fraction: 0.4 } : null;

  const notes = NOTES.slice(0, completed.length).map((bodyMd, index) => ({
    sessionIndex: completed[index],
    bodyMd,
  }));

  return {
    completed,
    inProgress,
    enrolledDaysAgo: 14,
    notes,
    deliverable: {
      sessionIndex: completed[0],
      url: 'https://github.com/example/docker-notes',
      comment: 'Wrote up the container mental model as a short README.',
    },
    events: buildEvents(completed, inProgress?.sessionIndex ?? completed[0]),
  };
}

/**
 * One event per active day, so the heatmap has texture: the finished sessions
 * land on the days they were finished, and the recent days are the session in
 * progress being opened again.
 */
function buildEvents(completed: number[], currentIndex: number): DemoEvent[] {
  const events: DemoEvent[] = [];

  ACTIVE_DAYS.forEach((daysAgo, position) => {
    // Oldest days carry the completions, most recent the session in progress.
    const fromEnd = ACTIVE_DAYS.length - 1 - position;
    const completion = completed[completed.length - 1 - Math.floor(fromEnd / 2)];

    events.push({ daysAgo, type: 'session.opened', sessionIndex: currentIndex });

    if (daysAgo >= 5 && completion !== undefined) {
      events.push({ daysAgo, type: 'session.completed', sessionIndex: completion });
    }
  });

  return events;
}
