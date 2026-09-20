import { z } from 'zod';

/**
 * Request shapes for the auth endpoints. These schemas are the contract:
 * they validate at runtime and generate the OpenAPI body schemas, so the
 * published spec and the accepted input cannot drift apart.
 */

/** Emails are compared case-insensitively, so normalise once at the edge. */
export const emailSchema = z
  .email({ message: 'Must be a valid email address' })
  .trim()
  .toLowerCase()
  .max(320);

/**
 * Length is the only rule worth enforcing. Composition rules push people
 * toward predictable substitutions; the upper bound is there because argon2
 * will happily burn CPU on a megabyte of input.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be at most 256 characters');

export const nameSchema = z.string().trim().min(1, 'Name is required').max(120);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  /** Required while SIGNUP_MODE is invite_only. */
  inviteToken: z.string().trim().min(1).max(256).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(256),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
