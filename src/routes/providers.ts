import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isPostgres } from '../lib/database.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';

const listQuery = z.object({
  status: z.enum(['Pending', 'Active', 'Suspended']).optional(),
  country: z.string().length(2).optional(),
  q: z.string().min(1).max(64).optional(),
  cursor: cursorParam,
  limit: limitParam,
  offset: z.coerce.number().int().min(0).default(0),
});

function nameContains(q: string): { contains: string; mode?: string } {
  const filter: { contains: string; mode?: string } = { contains: q };
  if (isPostgres) filter.mode = 'insensitive';
  return filter;
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers', async (req) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { status, country, q, cursor, limit, offset } = parsed.data;

    const formatProvider = (p: {
      address: string;
      name: string;
      country: string;
      status: string;
      registeredAt: Date;
      services: { code: number; label: string; price: string }[];
    }) => ({
      address: p.address,
      name: p.name,
      country: p.country,
      status: p.status,
      registeredAt: p.registeredAt,
      services: p.services.map((s) => ({
        code: s.code,
        label: s.label,
        price: s.price,
        priceDisplay: fromBaseUnits(s.price),
      })),
    });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }
      const cursorDate = new Date(decoded.createdAt);
      const where = {
        ...(status ? { status } : {}),
        ...(country ? { country } : {}),
        ...(q ? { name: nameContains(q) } : {}),
        OR: [
          { registeredAt: { lt: cursorDate } },
          { registeredAt: cursorDate, address: { lt: decoded.id } },
        ],
      };
      const rows = await prisma.provider.findMany({
        where,
        include: { services: { where: { active: true } } },
        orderBy: [{ registeredAt: 'desc' }, { address: 'desc' }],
        take: limit + 1,
      });
      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.registeredAt, last.address) : null;
      return { limit, nextCursor, providers: page.map(formatProvider) };
    }

    const where = {
      ...(status ? { status } : {}),
      ...(country ? { country } : {}),
      ...(q ? { name: nameContains(q) } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        include: { services: { where: { active: true } } },
        orderBy: [{ registeredAt: 'desc' }, { address: 'desc' }],
        take: limit + 1,
        skip: offset,
      }),
      prisma.provider.count({ where }),
    ]);

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasNext && last ? encodeCursor(last.registeredAt, last.address) : undefined;

    return { total, limit, offset, nextCursor, providers: page.map(formatProvider) };
  });

  app.get('/providers/:address', async (req) => {
    const { address } = req.params as { address: string };
    const p = await prisma.provider.findUnique({
      where: { address },
      include: { services: true },
    });
    if (!p) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    return {
      address: p.address,
      name: p.name,
      country: p.country,
      status: p.status,
      registeredAt: p.registeredAt,
      services: p.services.map((s) => ({
        code: s.code,
        label: s.label,
        price: s.price,
        priceDisplay: fromBaseUnits(s.price),
        active: s.active,
      })),
    };
  });

  /**
   * Every status transition observed for a clinic, oldest first.
   *
   * A clinic suspended twice a year reads very differently from one never
   * suspended, and the current status alone cannot tell them apart.
   */
  app.get('/providers/:address/history', async (req) => {
    const { address } = req.params as { address: string };
    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    const changes = await prisma.providerStatusChange.findMany({
      where: { providerAddress: address },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      address,
      history: changes.map((c) => ({
        status: c.status,
        ledger: c.ledger,
        changedAt: c.changedAt,
      })),
    };
  });

  /** Every observed price for one service, oldest first. */
  app.get('/providers/:address/services/:code/history', async (req) => {
    const { address, code } = req.params as { address: string; code: string };
    const serviceCode = Number(code);
    if (!Number.isInteger(serviceCode) || serviceCode < 0) {
      throw new ApiError(400, 'invalid_code', 'code must be a non-negative integer');
    }

    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    const changes = await prisma.servicePriceChange.findMany({
      where: { providerAddress: address, code: serviceCode },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      providerAddress: address,
      code: serviceCode,
      history: changes.map((c) => ({
        price: c.price,
        priceDisplay: fromBaseUnits(c.price),
        ledger: c.ledger,
        changedAt: c.changedAt,
      })),
    };
  });

  app.get('/countries', async () => {
    const grouped = await prisma.provider.groupBy({
      by: ['country'],
      where: { status: 'Active' },
      _count: { _all: true },
    });

    return {
      countries: grouped
        .map((g) => ({ code: g.country, clinicCount: g._count._all }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    };
  });
}
