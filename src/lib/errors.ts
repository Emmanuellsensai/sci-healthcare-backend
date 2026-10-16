import type { FastifyError } from 'fastify';

/**
 * The one error shape every route uses: `{ error, message, details? }`.
 *
 * Routes throw `ApiError`; the app-level error handler renders it. Anything
 * else — a crash, a Fastify built-in error, a rate-limit rejection — goes
 * through the same mapping, so a client never has to know which layer
 * refused the request or which shape that layer happened to use.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export type ErrorEnvelope = {
  error: string;
  message: string;
  details?: unknown;
};

/**
 * Maps any thrown value to a status code and the common envelope.
 *
 * Unrecognised 5xx errors deliberately lose their message: the cause and
 * stack belong in the log line, not in a response a client may display.
 */
export function errorEnvelope(err: unknown): { statusCode: number; body: ErrorEnvelope } {
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }

  const fastifyError = err as FastifyError;
  const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;

  if (statusCode === 429) {
    return { statusCode, body: { error: 'rate_limited', message: 'Too many requests' } };
  }
  if (statusCode >= 500) {
    return {
      statusCode: 500,
      body: { error: 'internal_error', message: 'Internal server error' },
    };
  }

  // Fastify's own 4xx errors (used here mainly by the rate limiter and body
  // parser) keep their message; validation errors add the issues as details.
  return {
    statusCode,
    body: {
      error: 'bad_request',
      message: fastifyError.message || 'Bad request',
      ...(fastifyError.validation !== undefined ? { details: fastifyError.validation } : {}),
    },
  };
}
