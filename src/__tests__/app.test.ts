import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';

const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

afterEach(() => vi.restoreAllMocks());

describe('request ids', () => {
  it('echoes a caller-supplied X-Request-Id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'support-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('support-123');
  });

  it('generates one when the caller does not send one', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('replaces an id that is not log-safe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'spaces and slashes /are not' },
    });
    expect(res.headers['x-request-id']).not.toBe('spaces and slashes /are not');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is present on error responses too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { 'x-request-id': 'error-id-1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('error-id-1');
  });

  it('matches the reqId in the log line for the same request', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });

    const loggedApp = await buildApp({ logger: { level: 'info', stream } });
    try {
      const res = await loggedApp.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'log-correlation-42' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toBe('log-correlation-42');
    } finally {
      await loggedApp.close();
    }

    expect(lines.join('')).toContain('"reqId":"log-correlation-42"');
  });
});

describe('versioned paths', () => {
  it('serves every route under /v1 without a deprecation header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['link']).toBeUndefined();
  });

  it('keeps unversioned paths as aliases carrying Deprecation and a successor link', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['link']).toBe('</v1/health>; rel="successor-version"');
  });

  it('points query strings at their /v1 equivalent', async () => {
    const res = await app.inject({ method: 'GET', url: '/vouchers' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['link']).toBe('</v1/vouchers>; rel="successor-version"');
  });

  it('mounts the same routes under /v1', async () => {
    const legacy = await app.inject({ method: 'GET', url: '/vouchers' });
    const v1 = await app.inject({ method: 'GET', url: '/v1/vouchers' });
    expect(v1.statusCode).toBe(legacy.statusCode);
    expect(v1.json()).toEqual(legacy.json());
    expect(v1.headers['deprecation']).toBeUndefined();
  });
});

describe('error envelope', () => {
  it('404s unknown routes in the envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'route_not_found',
      message: 'Route GET /does-not-exist not found',
    });
  });

  it('400s invalid queries with the zod issues as details', async () => {
    const res = await app.inject({ method: 'GET', url: '/vouchers?funder=short' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_query');
    expect(body.message).toBe('Invalid query parameters');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('400s a missing required filter without details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vouchers' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'filter_required',
      message: 'Provide at least one of: funder, provider, beneficiaryRef, status',
    });
  });

  it('500s unexpected failures as internal_error without leaking the cause', async () => {
    vi.spyOn(prisma.voucher, 'count').mockRejectedValue(
      new Error('connection reset by peer at 10.0.0.7'),
    );

    const res = await app.inject({ method: 'GET', url: `/vouchers?funder=${FUNDER}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' });
  });
});
