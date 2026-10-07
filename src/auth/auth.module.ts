import { Module } from '@nestjs/common';
import { MailService } from '../mail.service.js';
import { AuthController, MeController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, AuthGuard, MailService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
