import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { env } from './env.js';
import { errorEnvelope } from './lib/errors.js';
import { governanceRoutes } from './routes/governance.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/providers.js';
import { receiptRoutes } from './routes/receipts.js';
import { serviceRoutes } from './routes/services.js';
import { voucherRoutes } from './routes/vouchers.js';

/**
 * Request ids are opaque, bounded and safe to put in a log line. Anything
 * else in the header is ignored and replaced, so a caller cannot inject
 * control characters into logs or make them unbounded.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function genReqId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export type BuildAppOptions = {
  logger?: FastifyServerOptions['logger'];
};

async function registerRoutes(scope: FastifyInstance): Promise<void> {
  await scope.register(healthRoutes);
  await scope.register(providerRoutes);
  await scope.register(serviceRoutes);
  await scope.register(voucherRoutes);
  await scope.register(receiptRoutes);
  await scope.register(governanceRoutes);
}

/**
 * Builds the HTTP API without starting the indexer or listening.
 *
 * Kept separate from `index.ts` so route tests can drive the real app
 * through `app.inject()` against a throwaway database.
 */
export async function buildApp(
  opts: BuildAppOptions = { logger: { level: env.LOG_LEVEL } },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    genReqId,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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

  // Every response, including errors and 404s, carries the id that appears
  // in the matching log line.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = errorEnvelope(err);
    if (statusCode >= 500) req.log.error({ err }, 'request failed');
    else req.log.warn({ err }, 'request rejected');
    reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: 'route_not_found',
      message: `Route ${req.method} ${req.url} not found`,
    });
  });

  app.get('/openapi.json', { schema: { hide: true } }, async () => {
    return app.swagger();
  });

  // `/v1` is the canonical API. The unversioned paths stay as aliases for
  // clients already deployed against them, and say so on every response.
  await app.register(
    async (v1) => {
      await registerRoutes(v1);
    },
    { prefix: '/v1' },
  );

  await app.register(async (legacy) => {
    legacy.addHook('onSend', async (req, reply, payload) => {
      reply.header('deprecation', 'true');
      reply.header('link', `<${v1Path(req.url)}>; rel="successor-version"`);
      return payload;
    });
    await registerRoutes(legacy);
  });

  return app;
}

function v1Path(url: string): string {
  const path = url.replace(/[\r\n]/g, '');
  if (path.startsWith('/v1/') || path === '/v1') return path;
  return `/v1${path.startsWith('/') ? path : `/${path}`}`;
}
