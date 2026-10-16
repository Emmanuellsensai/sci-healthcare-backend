import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { isRefundable, isSettleable, refundableAt } from '../lib/lifecycle.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(STATUSES)).min(1));

const listQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
  status: statusList.optional(),
  cursor: cursorParam,
  limit: limitParam,
  offset: z.coerce.number().int().min(0).default(0),
});

const dueQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  within: z.string().regex(/^\d+[hmd]$/, 'within must be like 72h, 30d, or 45m'),
});

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get('/vouchers', {
    schema: {
      tags: ['vouchers'],
      summary: 'List vouchers',
      description: 'Returns vouchers matching the given filters. At least one filter is required.',
      querystring: listQuery,
    },
  }, async (req, reply) => {
    const { funder, provider, beneficiaryRef, status, cursor, limit, offset } = req.query as z.infer<typeof listQuery>;

    if (!funder && !provider && !beneficiaryRef && !status) {
      return reply.code(400).send({
        error: 'filter_required',
        message: 'Provide at least one of: funder, provider, beneficiaryRef, status',
      });
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return reply.code(400).send({ error: 'invalid_cursor' });
      }

      const cursorDate = new Date(decoded.createdAt);
      const where = {
        ...(funder ? { funder } : {}),
        ...(provider ? { providerAddress: provider } : {}),
        ...(beneficiaryRef ? { beneficiaryRef } : {}),
        ...(status ? { status: { in: status } } : {}),
        OR: [
          { createdAt: { lt: cursorDate } },
          { createdAt: cursorDate, id: { lt: decoded.id } },
        ],
      };

      const rows = await prisma.voucher.findMany({
        where,
        include: { provider: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const labels = await serviceLabels(page);
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : null;

      return { limit, nextCursor, vouchers: page.map((v) => serialise(v, labels)) };
    }

    const where = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      ...(beneficiaryRef ? { beneficiaryRef } : {}),
      ...(status ? { status: { in: status } } : {}),
    };

    const deprecation = offset > 0 ? { 'Deprecation': 'true' } : undefined;
    if (deprecation) reply.headers(deprecation);

    const [rows, total] = await Promise.all([
      prisma.voucher.findMany({
        where,
        include: { provider: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        skip: offset,
      }),
      prisma.voucher.count({ where }),
    ]);

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const labels = await serviceLabels(page);
    const last = page[page.length - 1];
    const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : undefined;

    return { total, limit, offset, nextCursor, vouchers: page.map((v) => serialise(v, labels)) };
  });

  f.get('/vouchers/due', {
    schema: {
      tags: ['vouchers'],
      summary: 'Vouchers due for action',
      description: 'Returns vouchers expiring, becoming refundable, or settleable within the given window.',
      querystring: dueQuery,
    },
  }, async (req, reply) => {
    const { funder, provider, within } = req.query as z.infer<typeof dueQuery>;

    if (!funder && !provider) {
      return reply.code(400).send({
        error: 'filter_required',
        message: 'Provide at least one of: funder, provider',
      });
    }

    const now = Date.now();
    const deadline = parseWithin(within, now);

    const where = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      status: { in: ['Funded', 'Claimed', 'Attested'] },
    };

    const rows = await prisma.voucher.findMany({
      where,
      include: { provider: true },
      orderBy: { expiresAt: 'asc' },
    });

    const labels = await serviceLabels(rows);
    const due = rows
      .filter((v) => {
        const timing = {
          status: v.status,
          expiresAt: v.expiresAt,
          disputeDeadline: v.disputeDeadline,
        };
        return (
          isRefundable(timing, deadline) ||
          isSettleable(timing, deadline)
        );
      })
      .map((v) => serialise(v, labels));

    return { total: due.length, vouchers: due };
  });

  f.get('/vouchers/:id', {
    schema: {
      tags: ['vouchers'],
      summary: 'Get a voucher by ID',
      description: 'Returns a single voucher with its receipt (if settled).',
      params: z.object({ id: z.string().describe('On-chain voucher ID') }),
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = await prisma.voucher.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!v) return reply.code(404).send({ error: 'voucher_not_found' });

    const [receipt, labels] = await Promise.all([
      prisma.receipt.findUnique({ where: { voucherId: id } }),
      serviceLabels([v]),
    ]);
    return { ...serialise(v, labels), receipt };
  });
}

function parseWithin(within: string, now: number): number {
  const match = within.match(/^(\d+)([hmd])$/);
  if (!match) return now;
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'm':
      return now + value * 60 * 1000;
    case 'h':
      return now + value * 60 * 60 * 1000;
    case 'd':
      return now + value * 24 * 60 * 60 * 1000;
    default:
      return now;
  }
}

type Row = {
  id: string;
  funder: string;
  beneficiaryRef: string;
  serviceCode: number;
  amount: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  attestedAt: Date | null;
  disputeDeadline: Date | null;
  disputeReason: number | null;
  settledNet: string | null;
  settledFee: string | null;
  providerAddress: string;
  provider: { name: string; country: string };
};

function serialise(v: Row, labels: Map<string, string>) {
  const refundable = refundableAt(v);
  return {
    id: v.id,
    funder: v.funder,
    beneficiaryRef: v.beneficiaryRef,
    provider: {
      address: v.providerAddress,
      name: v.provider.name,
      country: v.provider.country,
    },
    serviceCode: v.serviceCode,
    serviceLabel: labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
    amount: v.amount,
    amountDisplay: fromBaseUnits(v.amount),
    status: v.status,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    claimedAt: v.claimedAt,
    attestedAt: v.attestedAt,
    disputeDeadline: v.disputeDeadline,
    disputeReason: v.disputeReason,
    settledNet: v.settledNet,
    settledFee: v.settledFee,
    // Convenience flags so the UI does not re-derive the state machine.
    refundableAt: refundable,
    isSettleable: isSettleable(v),
    isRefundable: isRefundable(v),
  };
}
