import type { ValidationReport, ValidationResult } from '../course-spec/validation.types.js';

/**
 * Printing a validation report on a terminal.
 *
 * The same report the admin panel renders as a checklist (mockup 1h), and the
 * same ordering: what passed is shown, not only what failed, because an author
 * needs to know how far they got. Warnings never fail a package; only errors do.
 */

const ICON: Record<ValidationResult['severity'], string> = {
  pass: '✔',
  warning: '!',
  error: '✖',
};

/** The report as lines, ready to print. */
export function formatReport(report: ValidationReport): string[] {
  const lines: string[] = [];

  for (const result of report.results) {
    lines.push(`  ${ICON[result.severity]} ${result.message}`);

    if (result.detail) {
      // Codes are the stable part of a result, so show them beside the detail
      // rather than in the headline, where they would drown the sentence.
      for (const detail of result.detail.split('\n')) {
        lines.push(`      ${detail}`);
      }
    }
  }

  return lines;
}

/** One line saying whether the package would be accepted, and why not. */
export function summariseReport(report: ValidationReport): string {
  const errors = report.results.filter((r) => r.severity === 'error').length;
  const warnings = report.results.filter((r) => r.severity === 'warning').length;

  if (errors > 0) {
    return `${count(errors, 'error')}${warnings ? `, ${count(warnings, 'warning')}` : ''}. Not publishable yet.`;
  }

  if (warnings > 0) {
    return `${count(warnings, 'warning')}, nothing blocking. Publishable.`;
  }

  return 'No problems. Publishable.';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
