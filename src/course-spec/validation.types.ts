import { z } from 'zod';

/**
 * The course validation contract, frozen with the shell on 20 Sep 2026.
 * Recorded in Planning/Overall Plan.md §4 — read the rules there before
 * changing anything here.
 *
 * Two rules bear repeating because they are easy to break by accident:
 *
 *  1. `code` is the stable part. The admin panel keys its hints and icons off
 *     it and the shell's tests assert on it, so a code must never change
 *     meaning once published. `message` is free to be reworded at any time.
 *  2. One result per offending *file*, not per instance. Three external
 *     scripts in one HTML file is one thing the author has to go and fix.
 */

export const SEVERITIES = ['pass', 'warning', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Every code the validator can emit. Adding one is free; changing what an
 * existing one means is a breaking change for the shell.
 */
export const VALIDATION_CODES = [
  // passes
  'manifest_valid',
  'entries_found',
  'archive_safe',

  // manifest problems
  'manifest_missing',
  'manifest_invalid',
  'entry_missing',
  'duplicate_course_id',

  // archive problems
  'external_script',
  'disallowed_extension',
  'path_traversal',
  'symlink',
  'size_exceeded',

  // informational
  'cover_missing',
  'checks_skipped',
] as const;

export type ValidationCode = (typeof VALIDATION_CODES)[number];

export const validationResultSchema = z.object({
  severity: z.enum(SEVERITIES),
  /** Stable machine-readable identifier. See the note above. */
  code: z.enum(VALIDATION_CODES),
  /** Human-readable, free to change. Never assert on this. */
  message: z.string(),
  /**
   * Extra context for one result — offending URLs, the schema path that failed.
   * A single string; multiple lines are newline-separated and the panel renders
   * it with `white-space: pre-line`.
   */
  detail: z.string().optional(),
});

export const validationReportSchema = z.object({
  /** True when no result has severity `error`. Publish is gated on this. */
  ok: z.boolean(),
  /** Ordered in the order the checks ran, so the list reads top to bottom. */
  results: z.array(validationResultSchema),
});

export type ValidationResult = z.infer<typeof validationResultSchema>;
export type ValidationReport = z.infer<typeof validationReportSchema>;

/** Small builder so call sites read as the checklist the panel renders. */
export const result = (
  severity: Severity,
  code: ValidationCode,
  message: string,
  detail?: string,
): ValidationResult => ({ severity, code, message, ...(detail ? { detail } : {}) });

export const pass = (code: ValidationCode, message: string, detail?: string) =>
  result('pass', code, message, detail);
export const warning = (code: ValidationCode, message: string, detail?: string) =>
  result('warning', code, message, detail);
export const error = (code: ValidationCode, message: string, detail?: string) =>
  result('error', code, message, detail);

/**
 * `ok` is derived, never passed in: it is always "no errors", and computing it
 * in one place keeps that rule from drifting.
 */
export function toReport(results: ValidationResult[]): ValidationReport {
  return {
    ok: !results.some((r) => r.severity === 'error'),
    results,
  };
}

/**
 * Closes the one question a short list leaves open: is it short because the
 * package is nearly fine, or because validation gave up? Never synthesise
 * results for checks that did not run — say how many were skipped instead.
 */
export function checksSkipped(count: number, because: string): ValidationResult {
  return warning(
    'checks_skipped',
    `${count} further check${count === 1 ? '' : 's'} did not run; ${because}`,
  );
}
