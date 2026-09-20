import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'bud:isPublic';

/**
 * Opts a route out of the global SessionGuard. Authentication is on by default;
 * anything reachable without a session has to say so explicitly.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
