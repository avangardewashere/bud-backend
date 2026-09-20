import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../auth.types.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { SessionService } from '../session.service.js';

/**
 * Registered globally in AppModule, so every route requires a session unless it
 * is marked @Public(). Defaulting to closed means a new controller cannot leak
 * by omission — the mistake has to be explicit.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawToken = request.cookies?.[this.sessions.cookieName];

    if (!rawToken) {
      throw new UnauthorizedException('Authentication required.');
    }

    const resolved = await this.sessions.resolve(rawToken);
    if (!resolved) {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }

    request.user = resolved.user;
    request.budSession = resolved.session;

    return true;
  }
}
