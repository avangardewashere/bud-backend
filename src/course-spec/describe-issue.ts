import { suggestFieldFor } from './suggest-field.js';

/**
 * One Zod issue as a line an author can act on.
 *
 * Shared by the validator and by the CLI commands that parse a manifest for
 * their own reasons, because the alternative was two qualities of message for
 * the same mistake: `validate` telling an author that `description` is probably
 * `summary`, and `add-session` reporting a rejected key and a missing field as
 * two unrelated lines — which is exactly the gap the suggestion was written to
 * close.
 */
export function describeIssue(issue: {
  code: string;
  path: PropertyKey[];
  message: string;
}): string {
  const at = issue.path.map(String).join('.');
  const line = `${at || '(root)'}: ${issue.message}`;

  if (issue.code !== 'unrecognized_keys') {
    return line;
  }

  const suggestions = ((issue as { keys?: string[] }).keys ?? [])
    .map((key) => {
      const field = suggestFieldFor(key, at);
      return field ? `"${key}" → did you mean "${field}"?` : undefined;
    })
    .filter((suggestion): suggestion is string => suggestion !== undefined);

  return suggestions.length > 0 ? `${line}\n  ${suggestions.join('\n  ')}` : line;
}
