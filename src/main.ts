import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import morgan from 'morgan';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // rawBody: Stripe webhook signatures
  app.use(helmet());
  // One line per API call: method, path, status, size, time. Query strings are dropped (signed media URLs, tokens).
  // Off in tests; LOG_REQUESTS=0 turns it off anywhere.
  if (process.env.NODE_ENV !== 'test' && process.env.LOG_REQUESTS !== '0') {
    morgan.token('path', (req) => (req.url ?? '').split('?')[0]);
    app.use(morgan(':method :path :status :res[content-length] - :response-time ms'));
  }
  // The Next.js server calls us and forwards the visitor's IP; trust X-Forwarded-For only from it
  // (loopback locally — set TRUST_PROXY to the storefront's address/hops in production).
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean), credentials: true });
  // Reject unknown fields and validate every request body against its DTO.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
