import { emailSchema } from '../auth/dto/auth.schemas.js';

/**
 * One definition of "an address Bud accepts", shared by the CLIs and the API.
 *
 * The CLIs used to carry their own `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`, which is
 * looser than the schema `POST /auth/register` and `POST /auth/login` validate
 * with. Anything in the gap — a non-ASCII address like `josé@example.com`, a
 * double dot, a single-character TLD, a zero-width space `String.trim` does not
 * strip — was accepted here and refused there. The consequences differed by
 * command and both were silent:
 *
 * - `create-invite` printed a link its invitee could never redeem. They would
 *   see a bare validation error mentioning the email, nothing about the invite,
 *   and the only remedy is a second invite and a dead row left behind.
 * - `create-admin` created the account, which then could not sign in at all.
 *
 * So the check lives where the schema is, and the CLI says which address it
 * would not accept rather than inventing a second opinion about addresses.
 */
export type EmailArgument = { ok: true; email: string } | { ok: false; problem: string };

export function readEmailArgument(raw: string | undefined): EmailArgument {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, problem: 'An email address is required.' };
  }

  const parsed = emailSchema.safeParse(raw);

  if (!parsed.success) {
    // The schema's own message, so the CLI and a 400 from the API say the same
    // thing about the same address.
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      problem: `"${raw}" is not an address the API would accept: ${issue.message}`,
    };
  }

  return { ok: true, email: parsed.data };
}
