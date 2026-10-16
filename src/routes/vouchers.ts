import { Readable } from 'node:stream';

import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { csvRow } from '../lib/csv.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
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
  sort: z.enum(['createdAt', 'expiresAt', 'amount']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  cursor: cursorParam,
  limit: limitParam,
  offset: z.coerce.number().int().min(0).default(0),
});

/** The CSV export takes the filters but none of the paging or sort options. */
const csvQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
  status: statusList.optional(),
});

/** Columns exported as CSV. Deliberately no beneficiary reference. */
const CSV_COLUMNS = [
  'id',
  'funder',
  'providerAddress',
  'providerName',
  'providerCountry',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'status',
  'createdAt',
  'expiresAt',
  'claimedAt',
  'attestedAt',
  'disputeDeadline',
  'disputeReason',
  'settledNet',
  'settledFee',
  'refundableAt',
  'isSettleable',
  'isRefundable',
];

/** Rows fetched per database round trip; keeps export memory flat. */
const CSV_BATCH_SIZE = 500;

const dueQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  within: z.string().regex(/^\d+[hmd]$/, 'within must be like 72h, 30d, or 45m'),
});

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  app.get('/vouchers', async (req) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { funder, provider, beneficiaryRef, status, sort, order, cursor, limit, offset } =
      parsed.data;

    // At least one selector is required. An unfiltered dump of every
    // voucher in the system is not a useful endpoint and invites scraping.
    if (!funder && !provider && !beneficiaryRef && !status) {
      throw new ApiError(
        400,
        'filter_required',
        'Provide at least one of: funder, provider, beneficiaryRef, status',
      );
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
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

    const total = await prisma.voucher.count({ where });

    let rows: Row[];
    if (sort === 'amount') {
      const all = await prisma.voucher.findMany({ where, include: { provider: true } });
      all.sort((a, b) => compareAmount(a, b, order));
      rows = all.slice(offset, offset + limit + 1);
    } else {
      const primary = sort === 'createdAt' ? { createdAt: order } : { expiresAt: order };
      rows = await prisma.voucher.findMany({
        where,
        include: { provider: true },
        orderBy: [primary, { id: order }],
        take: limit + 1,
        skip: offset,
      });
    }

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const labels = await serviceLabels(page);
    const last = page[page.length - 1];
    const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : undefined;

    return { total, limit, offset, nextCursor, vouchers: page.map((v) => serialise(v, labels)) };
  });

  /**
   * The same vouchers as JSON `GET /vouchers`, as a streamed CSV download.
   *
   * At least one filter is required here too, so the export cannot become
   * an unauthenticated dump of every voucher. Rows are read in batches with
   * a cursor and written out as they arrive: the whole export never has to
   * fit in memory, however many rows match. There is deliberately no
   * beneficiary reference column.
   */
  app.get('/vouchers.csv', async (req, reply) => {
    const parsed = csvQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { funder, provider, beneficiaryRef, status } = parsed.data;

    if (!funder && !provider && !beneficiaryRef && !status) {
      throw new ApiError(
        400,
        'filter_required',
        'Provide at least one of: funder, provider, beneficiaryRef, status',
      );
    }

    const where: Prisma.VoucherWhereInput = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      ...(beneficiaryRef ? { beneficiaryRef } : {}),
      ...(status ? { status: { in: status } } : {}),
    };

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="vouchers.csv"')
      .header('cache-control', 'no-store');

    return reply.send(Readable.from(voucherCsv(where), { objectMode: false }));
  });

  app.get('/vouchers/due', async (req) => {
    const parsed = dueQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { funder, provider, within } = parsed.data;

    if (!funder && !provider) {
      throw new ApiError(400, 'filter_required', 'Provide at least one of: funder, provider');
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

  app.get('/vouchers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const v = await prisma.voucher.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!v) throw new ApiError(404, 'voucher_not_found', 'Voucher not found');

    const [receipt, labels] = await Promise.all([
      prisma.receipt.findUnique({ where: { voucherId: id } }),
      serviceLabels([v]),
    ]);
    return { ...serialise(v, labels), receipt };
  });
}

/**
 * Yields the CSV one line at a time. Rows are paged by voucher id, which is
 * unique and ordered, so a batch boundary can never skip or duplicate a row.
 */
async function* voucherCsv(where: Prisma.VoucherWhereInput): AsyncGenerator<string> {
  yield `${csvRow(CSV_COLUMNS)}\r\n`;

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.voucher.findMany({
      where,
      include: { provider: true },
      orderBy: { id: 'asc' },
      take: CSV_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (batch.length === 0) return;

    const labels = await serviceLabels(batch);
    for (const v of batch) {
      yield `${csvRow([
        v.id,
        v.funder,
        v.providerAddress,
        v.provider.name,
        v.provider.country,
        v.serviceCode,
        labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
        v.amount,
        fromBaseUnits(v.amount),
        v.status,
        v.createdAt,
        v.expiresAt,
        v.claimedAt,
        v.attestedAt,
        v.disputeDeadline,
        v.disputeReason,
        v.settledNet,
        v.settledFee,
        refundableAt(v),
        isSettleable(v),
        isRefundable(v),
      ])}\r\n`;
    }

    if (batch.length < CSV_BATCH_SIZE) return;
    cursor = batch[batch.length - 1]!.id;
  }
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

function compareAmount(
  a: { id: string; amount: string },
  b: { id: string; amount: string },
  order: 'asc' | 'desc',
): number {
  const av = BigInt(a.amount);
  const bv = BigInt(b.amount);
  const sign = order === 'asc' ? 1 : -1;
  if (av !== bv) return av < bv ? -sign : sign;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -sign : sign;
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
