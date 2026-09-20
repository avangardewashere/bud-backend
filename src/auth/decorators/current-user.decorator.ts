import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest, RequestUser } from '../auth.types.js';

/**
 * Injects the user resolved by SessionGuard. Only valid on guarded routes —
 * on a @Public() route there is nothing to inject.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return field ? request.user?.[field] : request.user;
  },
);
