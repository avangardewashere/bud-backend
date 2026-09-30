import { describe, expect, it } from 'vitest';

import { MANIFEST_FIELDS, SESSION_FIELDS } from './manifest.schema.js';
import { suggestFieldFor } from './suggest-field.js';

describe('suggestFieldFor', () => {
  it('knows the words other formats use for the same field', () => {
    // `description` is not a typo for `summary` — it is a different word for the
    // same idea, which no amount of string distance finds.
    expect(suggestFieldFor('description', '')).toBe('summary');
    expect(suggestFieldFor('lessons', '')).toBe('sessions');
    expect(suggestFieldFor('duration', '')).toBe('estimatedHours');
    expect(suggestFieldFor('thumbnail', '')).toBe('cover');
  });

  it('matches the level of the manifest the key was written at', () => {
    // `file` means `entry` inside a session, and there is no `entry` on the
    // course, so the same word must not be suggested at the top level.
    expect(suggestFieldFor('file', 'sessions.0')).toBe('entry');
    expect(suggestFieldFor('file', '')).toBeUndefined();
  });

  it('catches an ordinary typo', () => {
    expect(suggestFieldFor('titel', '')).toBe('title');
    expect(suggestFieldFor('sumary', '')).toBe('summary');
    expect(suggestFieldFor('storagekeys', '')).toBe('storageKeys');
  });

  it('is case-insensitive about what the author typed', () => {
    expect(suggestFieldFor('Description', '')).toBe('summary');
  });

  it('says nothing rather than guessing at an unrelated word', () => {
    // A wrong suggestion is worse than none: it sends the author to edit a
    // field that has nothing to do with what they meant.
    expect(suggestFieldFor('author', '')).toBeUndefined();
    expect(suggestFieldFor('licence', '')).toBeUndefined();
    expect(suggestFieldFor('xyzzy', '')).toBeUndefined();
  });

  it('is stricter about short names, where everything is close to everything', () => {
    // Two edits from a four-letter name is most of the name.
    expect(suggestFieldFor('idx', '')).toBe('id');
    expect(suggestFieldFor('zzzz', '')).toBeUndefined();
  });

  it('draws its vocabulary from the schema rather than a second list', () => {
    expect(MANIFEST_FIELDS).toContain('summary');
    expect(MANIFEST_FIELDS).toContain('storageKeys');
    expect(SESSION_FIELDS).toContain('entry');
    // If the schema gains a field, suggestions cover it with no second edit.
    expect(MANIFEST_FIELDS).not.toContain('description');
  });
});
