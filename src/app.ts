import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { env } from './env.js';
import { governanceRoutes } from './routes/governance.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/providers.js';
import { receiptRoutes } from './routes/receipts.js';
import { voucherRoutes } from './routes/vouchers.js';

export async function buildApp(
  opts: { logger?: boolean | { level: string } } = { logger: { level: env.LOG_LEVEL } },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, _req, reply) => {
    const err = error as Record<string, unknown>;
    if (err.validation || err.statusCode === 400) {
      const issues = err.validation ?? JSON.parse(typeof err.message === 'string' ? err.message : '[]');
      return reply.code(400).send({ error: 'invalid_query', issues });
    }
    const code = typeof err.statusCode === 'number' ? err.statusCode : 500;
    reply.code(code).send({ error: typeof err.message === 'string' ? err.message : 'internal_error' });
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'SCI Healthcare API',
        description:
          'Read-only API for the SCI Healthcare care-voucher protocol on Stellar. ' +
          'All monetary amounts are decimal strings representing i128 values in ' +
          'base units (stroops). A 7-decimal Stellar asset like USDC uses 10^7 ' +
          'base units per whole token, so "30000000" = 3.0000000 USDC. Amounts ' +
          'are strings, not numbers, because they can exceed Number.MAX_SAFE_INTEGER.',
        version: '0.3.0',
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET'],
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  app.get('/openapi.json', { schema: { hide: true } }, async () => {
    return app.swagger();
  });

  await app.register(healthRoutes);
  await app.register(providerRoutes);
  await app.register(voucherRoutes);
  await app.register(receiptRoutes);
  await app.register(governanceRoutes);

  return app;
}
