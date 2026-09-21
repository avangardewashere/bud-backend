/**
 * Markdown helpers for the notes export.
 *
 * The export wraps each note in a heading of its own, so a note that starts
 * with `# Session 1` — which is exactly how someone writes notes.md — ends up
 * with an H1 nested inside an H2, and the document has two competing titles.
 * Demoting the note's own headings keeps one outline.
 */

/** ``` or ~~~, with any number of extra characters and an optional language. */
const FENCE = /^(\s{0,3})(`{3,}|~{3,})/;
const ATX_HEADING = /^(\s{0,3})(#{1,6})(\s|$)/;

/**
 * Shifts every ATX heading down by `levels`, stopping at H6.
 *
 * Fenced code blocks are left alone, which is the part that matters: notes for
 * a Docker course are full of shell snippets, and `# rebuild the image` inside
 * a ``` block is a comment, not a heading. Rewriting it would corrupt the
 * commands the learner wrote down.
 */
export function demoteHeadings(markdown: string, levels: number): string {
  if (levels <= 0) {
    return markdown;
  }

  const lines = markdown.split('\n');
  let fence: string | null = null;

  return lines
    .map((line) => {
      const fenceMatch = FENCE.exec(line);

      if (fenceMatch) {
        const marker = fenceMatch[2];

        if (fence === null) {
          // Opening a block; remember which marker opened it.
          fence = marker[0];
          return line;
        }

        // A closing fence must use the same character and be at least as long.
        if (marker[0] === fence) {
          fence = null;
        }
        return line;
      }

      if (fence !== null) {
        return line;
      }

      const heading = ATX_HEADING.exec(line);
      if (!heading) {
        return line;
      }

      const [, indent, hashes, after] = heading;
      const depth = Math.min(hashes.length + levels, 6);

      return `${indent}${'#'.repeat(depth)}${after}${line.slice(heading[0].length)}`;
    })
    .join('\n');
}
