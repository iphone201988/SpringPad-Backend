import { createParamDecorator, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';

export type AuthedCustomer = { sessionId: string; id: string; email: string; firstName: string; lastName: string; displayName: string | null };
type AuthedRequest = Request & { customer?: AuthedCustomer; sessionToken?: string };

export const bearer = (req: Request) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];

// Requires a valid session token (Authorization: Bearer …). The Next.js server sends it from its httpOnly cookie.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) { }

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    const customer = token && (await this.auth.customerForSession(token));
    if (!customer) throw new UnauthorizedException();
    req.customer = customer;
    return true;
  }
}

export const CurrentCustomer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().customer!,
);
