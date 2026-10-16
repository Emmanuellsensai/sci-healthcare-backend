import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const listQuery = z
  .object({
    beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
    provider: z.string().length(56).optional(),
    cursor: cursorParam,
    limit: limitParam,
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => Boolean(data.beneficiaryRef) !== Boolean(data.provider), {
    message: 'Provide exactly one of: beneficiaryRef, provider',
    path: ['beneficiaryRef', 'provider'],
  });

const voucherIdParam = z.object({
  voucherId: z.string().min(1),
});

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get('/receipts', {
    schema: {
      tags: ['receipts'],
      summary: 'List receipts',
      description:
        'A patient\'s care history. Requires exactly one of beneficiaryRef or provider.',
      querystring: listQuery,
    },
  }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { beneficiaryRef, provider, cursor, limit, offset } = parsed.data;

    const baseWhere = beneficiaryRef
      ? { beneficiaryRef }
      : { providerAddress: provider! };

    const isProviderView = Boolean(provider);

    const formatReceipt = (r: {
      voucherId: string;
      providerAddress: string;
      serviceCode: number;
      amount: string;
      settledAt: Date;
      beneficiaryRef: string;
    }, labels: Map<string, string>) => ({
      voucherId: r.voucherId,
      providerAddress: r.providerAddress,
      serviceCode: r.serviceCode,
      serviceLabel: labels.get(serviceKey(r.providerAddress, r.serviceCode)) ?? null,
      amount: r.amount,
      amountDisplay: fromBaseUnits(r.amount),
      settledAt: r.settledAt,
      ...(isProviderView ? {} : { beneficiaryRef: r.beneficiaryRef }),
    });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return reply.code(400).send({ error: 'invalid_cursor' });
      }
      const cursorDate = new Date(decoded.createdAt);
      const where = {
        ...baseWhere,
        OR: [
          { settledAt: { lt: cursorDate } },
          { settledAt: cursorDate, voucherId: { lt: decoded.id } },
        ],
      };
      const rows = await prisma.receipt.findMany({
        where,
        orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
        take: limit + 1,
      });
      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const labels = await serviceLabels(page);
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.settledAt, last.voucherId) : null;
      return { limit, nextCursor, receipts: page.map((r) => formatReceipt(r, labels)) };
    }

    const deprecation = offset > 0 ? { 'Deprecation': 'true' } : undefined;
    if (deprecation) reply.headers(deprecation);

    const [rows, total, spend] = await Promise.all([
      prisma.receipt.findMany({
        where: baseWhere,
        orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.receipt.count({ where: baseWhere }),
      prisma.receipt.findMany({
        where: baseWhere,
        select: { amount: true },
      }),
    ]);

    const labels = await serviceLabels(rows);
    const totalSpend = spend
      .reduce((acc, r) => acc + BigInt(r.amount), 0n)
      .toString();

    return {
      total,
      limit,
      offset,
      totalSpend,
      totalSpendDisplay: fromBaseUnits(totalSpend),
      receipts: rows.map((r) => formatReceipt(r, labels)),
    };
  });

  f.get('/receipts/:voucherId', {
    schema: {
      tags: ['receipts'],
      summary: 'Get a receipt by voucher ID',
      description: 'Single receipt for verification. No beneficiary reference in the response.',
      params: voucherIdParam,
    },
  }, async (req, reply) => {
    const parsed = voucherIdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { voucherId } = parsed.data;

    const receipt = await prisma.receipt.findUnique({
      where: { voucherId },
    });
    if (!receipt) return reply.code(404).send({ error: 'receipt_not_found' });

    const labels = await serviceLabels([receipt]);
    return {
      voucherId: receipt.voucherId,
      providerAddress: receipt.providerAddress,
      serviceCode: receipt.serviceCode,
      serviceLabel: labels.get(serviceKey(receipt.providerAddress, receipt.serviceCode)) ?? null,
      amount: receipt.amount,
      amountDisplay: fromBaseUnits(receipt.amount),
      settledAt: receipt.settledAt,
    };
  });
}
