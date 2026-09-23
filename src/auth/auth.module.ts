import { Module } from '@nestjs/common';

import { DemoModule } from '../demo/demo.module.js';

import { AuthController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GithubOAuthController } from './github-oauth.controller.js';
import { GithubOAuthService } from './github-oauth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [DemoModule],
  controllers: [AuthController, GithubOAuthController, MeController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    LoginThrottleService,
    GithubOAuthService,
  ],
  // SessionService is exported because the global SessionGuard depends on it.
  exports: [AuthService, SessionService, PasswordService],
})
export class AuthModule {}
