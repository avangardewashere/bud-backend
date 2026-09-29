import { describe, expect, it } from 'vitest';

import { openApiSchema } from '../../common/validation/zod.pipe.js';
import { emailSchema, loginSchema, registerSchema } from './auth.schemas.js';

/**
 * The email schema is the only normalisation step between what a person types
 * and what everything else compares: sessions, invites, the unique index. So
 * "normalise once at the edge" has to actually happen at the edge.
 */
describe('emailSchema', () => {
  it.each([
    ['Bob@Example.COM', 'bob@example.com'],
    [' bob@example.com ', 'bob@example.com'],
    ['bob@example.com\n', 'bob@example.com'],
    ['\tBob@Example.com  ', 'bob@example.com'],
  ])('normalises %j to %j', (input, expected) => {
    // Written the obvious way round — z.email().trim().toLowerCase() — the
    // format check runs before the transforms, so a padded address was rejected
    // as malformed instead of cleaned up and the .trim() was dead. Lower-casing
    // happened to work, which is why it went unnoticed.
    expect(emailSchema.parse(input)).toBe(expected);
  });

  it.each([['no-at-sign'], [''], ['   '], ['bob@'], ['@example.com'], ['bob@example']])(
    'rejects %j',
    (input) => {
      expect(emailSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects an address longer than the column', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(320)}@example.com`).success).toBe(false);
  });

  it('normalises on the way into login as well as register', () => {
    // Both routes share the schema, so a learner who pastes their address with
    // a trailing newline signs in rather than seeing a validation error.
    expect(
      loginSchema.parse({ email: ' Bob@Example.com ', password: 'whatever-they-typed' }).email,
    ).toBe('bob@example.com');

    expect(
      registerSchema.parse({
        email: 'Bob@Example.com ',
        password: 'a-password-of-some-length',
        name: 'Bob',
      }).email,
    ).toBe('bob@example.com');
  });

  it('publishes the same JSON Schema it always did', () => {
    // The shell generates its client from this, so normalising must not cost the
    // published contract anything. It nearly did: written as `.pipe()`, Zod
    // derives the input schema from the left-hand side and the email property
    // became a bare `type: string` — no format, no maxLength, no pattern.
    const email = (openApiSchema(registerSchema) as { properties: Record<string, unknown> })
      .properties.email;

    expect(email).toMatchObject({ type: 'string', format: 'email', maxLength: 320 });
    expect(email).toHaveProperty('pattern');
  });
});
