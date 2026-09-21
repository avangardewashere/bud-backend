import { describe, expect, it } from 'vitest';

import { demoteHeadings } from './markdown.js';

describe('demoteHeadings', () => {
  it('shifts headings down so the export keeps one outline', () => {
    expect(demoteHeadings('# Session 1', 2)).toBe('### Session 1');
    expect(demoteHeadings('## Sub', 2)).toBe('#### Sub');
  });

  it('stops at H6 rather than emitting nonsense', () => {
    expect(demoteHeadings('##### Deep', 2)).toBe('###### Deep');
    expect(demoteHeadings('###### Deepest', 2)).toBe('###### Deepest');
  });

  it('leaves ordinary text alone', () => {
    const body = 'An image is a *template*.\n\nA container is a running one.';

    expect(demoteHeadings(body, 2)).toBe(body);
  });

  it('does not touch a # inside a fenced code block', () => {
    // The whole reason this function parses rather than regexes: notes for a
    // Docker course are full of shell, and rewriting a comment would corrupt
    // the commands the learner wrote down.
    const body = [
      '# Real heading',
      '',
      '```bash',
      '# rebuild the image',
      'docker build .',
      '```',
    ].join('\n');

    const result = demoteHeadings(body, 2);

    expect(result).toContain('### Real heading');
    expect(result).toContain('# rebuild the image');
    expect(result).not.toContain('### rebuild the image');
  });

  it('handles tilde fences as well as backticks', () => {
    const body = ['~~~', '# not a heading', '~~~'].join('\n');

    expect(demoteHeadings(body, 2)).toBe(body);
  });

  it('does not let a tilde close a backtick block', () => {
    // Mismatched markers do not close each other, so everything between stays
    // code and stays untouched.
    const body = ['```', '~~~', '# still code', '```', '# a heading now'].join('\n');

    const result = demoteHeadings(body, 2);

    expect(result).toContain('# still code');
    expect(result).toContain('### a heading now');
  });

  it('ignores a # that is not a heading', () => {
    // No space after the hashes, so CommonMark does not treat it as a heading.
    expect(demoteHeadings('#hashtag', 2)).toBe('#hashtag');
  });

  it('keeps an unclosed code block from swallowing nothing', () => {
    const body = ['# Heading', '```', '# code'].join('\n');
    const result = demoteHeadings(body, 2);

    expect(result).toContain('### Heading');
    // Still inside the unclosed block, so left alone.
    expect(result).toContain('# code');
  });

  it('preserves indentation', () => {
    expect(demoteHeadings('  ## Indented', 1)).toBe('  ### Indented');
  });

  it('is a no-op when asked to shift by nothing', () => {
    expect(demoteHeadings('# Heading', 0)).toBe('# Heading');
  });
});
