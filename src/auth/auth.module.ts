import { Module } from '@nestjs/common';

import { AuthController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, PasswordService, SessionService, LoginThrottleService],
  // SessionService is exported because the global SessionGuard depends on it.
  exports: [AuthService, SessionService, PasswordService],
})
export class AuthModule {}
