import type { CourseManifest } from '../course-spec/manifest.schema.js';

/**
 * What `bud-course init` writes.
 *
 * The files are the point, not the command: authoring friction lives almost
 * entirely in the bridge, and a first session that already uses it correctly is
 * worth more than any amount of documentation. Every call in the template is
 * from the frozen contract in Overall Plan §3, spelled the way the Docker
 * worksheets spell it — `storage.get` resolves to `{ value }`, a JSON string or
 * null, which is the detail everyone gets wrong first.
 *
 * Kept as data so a test can scaffold, validate and read it without touching a
 * filesystem.
 */

export interface ScaffoldFile {
  path: string;
  content: string;
}

/** A slug the manifest will accept, derived from whatever the folder is called. */
export function slugify(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // courseIdSchema: lowercase letters, digits and single hyphens, 2 to 64 long.
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 64
    ? slug
    : null;
}

/** Title Case-ish, for a placeholder title an author will replace anyway. */
function titleFrom(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function scaffoldFiles(id: string, title?: string): ScaffoldFile[] {
  const courseTitle = title ?? titleFrom(id);
  const stateKey = `${id}:session-1`;

  const manifest: CourseManifest = {
    spec: 'bud-course/1',
    id,
    title: courseTitle,
    version: '1.0.0',
    summary: `One sentence a learner reads before deciding to start ${courseTitle}.`,
    level: 'beginner',
    estimatedHours: 1,
    tags: [],
    outline: 'outline.md',
    // Explicitly null rather than absent, so the field is visible to fill in.
    cover: null,
    theme: { accent: '#1E6FA8' },
    storageKeys: [stateKey],
    sessions: [
      {
        id: 's1',
        order: 1,
        title: 'Your first session',
        entry: 'session-1.html',
        weight: 'light',
      },
    ],
  };

  return [
    { path: 'bud.manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'outline.md', content: outline(courseTitle) },
    { path: 'session-1.html', content: session(courseTitle, stateKey) },
  ];
}

function outline(title: string): string {
  return `# ${title}

What a learner sees on the course page, as Markdown. Describe what they will be
able to do at the end, not what the course contains.

## Session 1 — Your first session

Replace this, and add a heading per session as you write them.
`;
}

/**
 * The template session. Everything here is the frozen bridge contract:
 *
 * - `storage.get(key)` resolves to `{ value }` — a string or null, *not* the
 *   value itself. This is the one people get wrong.
 * - `storage.set(key, value)` takes a string, so state is JSON.
 * - `storage.delete(key)` is what "clear saved work" needs. Without it, a reset
 *   button silently does nothing.
 * - `bud.height(px)` lets the frame grow to the content, so the shell owns
 *   scrolling rather than the course having its own scrollbar.
 * - `bud.ready()` tells the shell to drop its loading state.
 */
function session(title: string, stateKey: string): string {
  return `<meta charset="utf-8">
<title>${title} — Your first session</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 46rem; }
  label { display: block; margin: 1.25rem 0 0.35rem; font-weight: 600; }
  textarea { width: 100%; min-height: 6rem; font: inherit; padding: 0.5rem; }
  .row { display: flex; gap: 0.75rem; align-items: center; margin-top: 1.5rem; }
  .saved { color: #6b7280; font-size: 0.875rem; }
</style>

<h1>Your first session</h1>

<p>
  Write the session here as ordinary HTML. Bud never parses or restyles it — it
  serves it in a sandboxed frame and gives it one thing: somewhere to save.
</p>

<label>
  <input type="checkbox" id="done"> I have read this
</label>

<label for="notes">What did you learn?</label>
<textarea id="notes"></textarea>

<div class="row">
  <button type="button" id="clear">Clear saved work</button>
  <span class="saved" id="status"></span>
</div>

<script>
  // Everything below is the bridge contract. See the course spec at
  // GET /course-spec/schema, and Bud's README section "Authoring a course".
  const KEY = ${JSON.stringify(stateKey)};

  // So this file is also openable straight from disk while you write it. Inside
  // Bud, window.storage is injected before the page runs and this is unused.
  const storage =
    window.storage ??
    {
      get: (key) => Promise.resolve({ value: localStorage.getItem(key) }),
      set: (key, value) => Promise.resolve(localStorage.setItem(key, value)),
      delete: (key) => Promise.resolve(localStorage.removeItem(key)),
    };
  const bud = window.bud ?? { ready() {}, height() {}, complete() {}, progress() {} };

  const done = document.getElementById('done');
  const notes = document.getElementById('notes');
  const status = document.getElementById('status');

  let state = { done: false, notes: '' };

  function render() {
    done.checked = state.done;
    notes.value = state.notes;
  }

  let timer;
  function save() {
    clearTimeout(timer);
    // Debounced, because this fires per keystroke and every call is a request.
    timer = setTimeout(async () => {
      // set() takes a string, so state is JSON.
      await storage.set(KEY, JSON.stringify(state));
      status.textContent = 'Saved';
      if (state.done) bud.complete('s1');
    }, 400);
  }

  done.addEventListener('change', () => {
    state.done = done.checked;
    save();
  });

  notes.addEventListener('input', () => {
    state.notes = notes.value;
    save();
  });

  document.getElementById('clear').addEventListener('click', async () => {
    // confirm() needs allow-modals, which the player's sandbox grants.
    if (!confirm('Clear the work saved for this session?')) return;
    await storage.delete(KEY);
    state = { done: false, notes: '' };
    render();
    status.textContent = 'Cleared';
  });

  // Report the height so the frame grows to the content and the shell owns
  // scrolling. Do it whenever the content changes, not only on load.
  function reportHeight() {
    bud.height(document.body.scrollHeight);
  }
  new ResizeObserver(reportHeight).observe(document.body);

  (async () => {
    // get() resolves to { value } — a string or null — not the value itself.
    const result = await storage.get(KEY);
    if (result && result.value) {
      try {
        state = { ...state, ...JSON.parse(result.value) };
      } catch {
        // Saved by an older version of this session; start clean rather than
        // throwing away the learner's next keystroke with an unhandled error.
      }
    }

    render();
    reportHeight();
    bud.ready();
  })();
</script>
`;
}
