import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Zod is the single source of truth for request shapes. One schema drives
 * validation here and the OpenAPI body/response schema via `openApiSchema`,
 * so the published contract cannot drift from what the code accepts.
 *
 * Written in-repo rather than pulled from nestjs-zod, which still peers on
 * NestJS 10/11 and would have pinned the whole app a major version back.
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        error: 'Bad Request',
        message: 'Validation failed',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data;
  }
}

/** Convenience for `@Body(zodBody(Schema))`. */
export const zodBody = <T extends z.ZodType>(schema: T) => new ZodValidationPipe(schema);

/**
 * Zod 4 emits JSON Schema natively, which is exactly what OpenAPI wants.
 * `io: 'input'` so documented request bodies describe what to send, not what
 * the schema produces after transforms and defaults.
 */
export function openApiSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): SchemaObject {
  return z.toJSONSchema(schema, { io, target: 'openapi-3.0' }) as SchemaObject;
}
