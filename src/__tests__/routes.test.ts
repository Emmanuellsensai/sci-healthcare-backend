import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { CONTRACTS, env } from '../env.js';
import { encodeCursor } from '../lib/cursor.js';
import { CLAIM_GRACE_MS } from '../lib/lifecycle.js';
import { server } from '../stellar/client.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const SECOND_CLINIC = 'GCMDQZBBTZBR3ZDPCEFSDNNWVQFA44VHOJHR2JZTL7CHJHZ3N2LQDW3B';
const PENDING_CLINIC = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ADMIN = 'A'.repeat(56);
const NEW_ADMIN = 'B'.repeat(56);
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const OTHER_REF = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const REGISTRY = CONTRACTS.find((c) => c.contract === 'registry')!.contractId;
const VOUCHER = CONTRACTS.find((c) => c.contract === 'voucher')!.contractId;

let app: FastifyInstance;

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

async function getCsv(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.body, headers: res.headers, json: () => res.json() };
}

/** Parses RFC 4180 CSV into rows of cells, so tests exercise the real escaping. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function seed() {
  await prisma.provider.create({
    data: {
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
      status: 'Active',
      registeredAt: new Date('2026-09-01T00:00:00Z'),
      services: {
        create: [
          { id: `${CLINIC}:101`, code: 101, label: 'Outpatient consult', price: '30000000' },
          { id: `${CLINIC}:202`, code: 202, label: 'Malaria rapid test', price: '10000000' },
          // Delisted after vouchers were funded against it.
          {
            id: `${CLINIC}:303`,
            code: 303,
            label: 'Antenatal visit',
            price: '50000000',
            active: false,
          },
        ],
      },
    },
  });
  await prisma.provider.create({
    data: {
      address: PENDING_CLINIC,
      name: 'Kisumu Health Post',
      country: 'KE',
      status: 'Pending',
      registeredAt: new Date('2026-09-05T00:00:00Z'),
    },
  });
  await prisma.provider.create({
    data: {
      address: SECOND_CLINIC,
      name: 'Mwanza Mission Hospital',
      country: 'TZ',
      status: 'Active',
      registeredAt: new Date('2026-08-15T00:00:00Z'),
      services: {
        create: [
          { id: `${SECOND_CLINIC}:101`, code: 101, label: 'General consultation', price: '40000000' },
          { id: `${SECOND_CLINIC}:202`, code: 202, label: 'Malaria rapid test', price: '15000000' },
          { id: `${SECOND_CLINIC}:404`, code: 404, label: 'Dental cleaning', price: '20000000' },
        ],
      },
    },
  });

  const now = Date.now();
  const base = { funder: FUNDER, beneficiaryRef: REF, providerAddress: CLINIC };
  await prisma.voucher.createMany({
    data: [
      // Settled, with a receipt below.
      {
        ...base,
        id: '1',
        serviceCode: 101,
        amount: '30000000',
        status: 'Settled',
        createdAt: new Date(now - 10 * DAY),
        expiresAt: new Date(now + 20 * DAY),
        settledNet: '29700000',
        settledFee: '300000',
      },
      // Funded and already past expiry: refundable now.
      {
        ...base,
        id: '2',
        serviceCode: 202,
        amount: '10000000',
        status: 'Funded',
        createdAt: new Date(now - 40 * DAY),
        expiresAt: new Date(now - DAY),
      },
      // Claimed, expired yesterday: still inside the claim grace period.
      {
        ...base,
        id: '3',
        serviceCode: 303,
        amount: '50000000',
        status: 'Claimed',
        createdAt: new Date(now - 31 * DAY),
        expiresAt: new Date(now - DAY),
      },
      // Attested with the dispute window closed: settleable.
      {
        ...base,
        id: '4',
        serviceCode: 101,
        amount: '30000000',
        status: 'Attested',
        createdAt: new Date(now - 5 * DAY),
        expiresAt: new Date(now + 25 * DAY),
        disputeDeadline: new Date(now - 60_000),
      },
      // Disputed, for someone else, with a reason.
      {
        ...base,
        beneficiaryRef: OTHER_REF,
        id: '5',
        serviceCode: 999,
        amount: '30000000',
        status: 'Disputed',
        createdAt: new Date(now - 2 * DAY),
        expiresAt: new Date(now + 28 * DAY),
        disputeReason: 2,
      },
    ],
  });
  await prisma.receipt.createMany({
    data: [
      {
        voucherId: '1',
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '30000000',
        settledAt: new Date(now - 6 * DAY),
      },
      {
        voucherId: '9',
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 202,
        amount: '10000000',
        settledAt: new Date(now - 3 * DAY),
      },
    ],
  });

  const at = (dayOffset: number) => new Date(now - dayOffset * DAY);
  await prisma.governanceEvent.createMany({
    data: [
      {
        id: 'gov-1',
        contractId: REGISTRY,
        contract: 'registry',
        kind: 'Proposed',
        admin: ADMIN,
        pendingAdmin: NEW_ADMIN,
        ledger: 10,
        occurredAt: at(30),
      },
      {
        id: 'gov-2',
        contractId: REGISTRY,
        contract: 'registry',
        kind: 'Changed',
        admin: NEW_ADMIN,
        pendingAdmin: null,
        ledger: 12,
        occurredAt: at(29),
      },
      {
        id: 'gov-3',
        contractId: VOUCHER,
        contract: 'voucher',
        kind: 'Proposed',
        admin: ADMIN,
        pendingAdmin: NEW_ADMIN,
        ledger: 14,
        occurredAt: at(28),
      },
    ],
  });
  await prisma.providerStatusChange.createMany({
    data: [
      { id: 'st-1', providerAddress: CLINIC, status: 'Active', ledger: 10, changedAt: at(20) },
      {
        id: 'st-2',
        providerAddress: CLINIC,
        status: 'Suspended',
        ledger: 12,
        changedAt: at(15),
      },
      { id: 'st-3', providerAddress: CLINIC, status: 'Active', ledger: 14, changedAt: at(10) },
    ],
  });
  await prisma.servicePriceChange.createMany({
    data: [
      {
        id: 'sp-1',
        providerAddress: CLINIC,
        code: 101,
        price: '30000000',
        ledger: 10,
        changedAt: at(20),
      },
      {
        id: 'sp-2',
        providerAddress: CLINIC,
        code: 101,
        price: '35000000',
        ledger: 12,
        changedAt: at(15),
      },
    ],
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.governanceEvent.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await seed();
});

describe('OpenAPI spec', () => {
  it('serves a valid spec at /openapi.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('SCI Healthcare API');
    expect(spec.paths['/vouchers']).toBeDefined();
    expect(spec.paths['/providers']).toBeDefined();
    expect(spec.paths['/receipts']).toBeDefined();
    expect(spec.paths['/governance']).toBeDefined();
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    // swagger-ui redirects to /docs/ or returns HTML
    expect([200, 302]).toContain(res.statusCode);
  });
});

describe('GET /health and /stats', () => {
  it('reports liveness', async () => {
    expect(await get('/health')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('counts providers, vouchers and settled value', async () => {
    const { status, body } = await get('/stats');
    expect(status).toBe(200);
    expect(body).toEqual({
      providers: 3,
      activeProviders: 2,
      vouchers: 5,
      settledVouchers: 1,
      settledValue: '30000000',
      receipts: 2,
    });
  });
});

describe('GET /ready', () => {
  afterEach(() => vi.restoreAllMocks());

  async function seedCursor(lastLedger: number) {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger },
      update: { lastLedger, leaseOwner: null, leaseExpiresAt: null },
    });
  }

  it('defaults the lag threshold to 120 ledgers', () => {
    expect(env.READY_MAX_LAG_LEDGERS).toBe(120);
  });

  it('is ready at exactly the threshold', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1120 } as never);

    const { status, body } = await get('/ready');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks).toMatchObject({
      indexer: 'ok',
      lagLedgers: 120,
      maxLagLedgers: env.READY_MAX_LAG_LEDGERS,
    });
  });

  it('is degraded one ledger past the threshold', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1121 } as never);

    const { status, body } = await get('/ready');
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks).toMatchObject({
      indexer: 'lagging',
      lagLedgers: 121,
      maxLagLedgers: env.READY_MAX_LAG_LEDGERS,
    });
  });

  it('returns 503 with gap details when the indexer has a retention gap', async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 50, gap: true, gapOldestLedger: 200, gapCursorLedger: 50 },
      update: { lastLedger: 50, gap: true, gapOldestLedger: 200, gapCursorLedger: 50, leaseOwner: null, leaseExpiresAt: null },
    });
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);

    const { status, body } = await get('/ready');
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.indexer).toBe('gap');
    expect(body.checks.gap).toMatchObject({
      detected: true,
      cursorLedger: 50,
      oldestAvailable: 200,
    });
    expect(body.checks.gap.message).toContain('RUNBOOK');
  });
});

describe('GET /providers', () => {
  it('filters by status and lists only active services', async () => {
    const { body } = await get('/providers?status=Active');
    expect(body.total).toBe(2);
    expect(body.providers[0].name).toBe('Ikeja General Clinic');
    expect(body.providers[0].services.map((s: { code: number }) => s.code)).toEqual([101, 202]);
    expect(body.providers[0].services[0].priceDisplay).toBe('3.0000000');
  });

  it('filters by country', async () => {
    const { body } = await get('/providers?country=KE');
    expect(body.providers.map((p: { address: string }) => p.address)).toEqual([PENDING_CLINIC]);
  });

  it('rejects an invalid status', async () => {
    const { status, body } = await get('/providers?status=Verified');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('returns one provider with its full catalogue, including delisted services', async () => {
    const { body } = await get(`/providers/${CLINIC}`);
    expect(body.services).toHaveLength(3);
    expect(body.services.find((s: { code: number }) => s.code === 303).active).toBe(false);
  });

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /providers search', () => {
  it('matches a lower-case substring against a mixed-case name', async () => {
    const { body } = await get('/providers?q=ikeja');
    expect(body.total).toBe(1);
    expect(body.providers[0].name).toBe('Ikeja General Clinic');
  });

  it('matches an upper-case substring', async () => {
    const { body } = await get('/providers?q=KISUMU');
    expect(body.total).toBe(1);
    expect(body.providers[0].name).toBe('Kisumu Health Post');
  });

  it('matches a mid-name substring regardless of case', async () => {
    const { body } = await get('/providers?q=GENERAL');
    expect(body.total).toBe(1);
    expect(body.providers[0].name).toBe('Ikeja General Clinic');
  });

  it('returns nothing when no name matches', async () => {
    const { body } = await get('/providers?q=zzz');
    expect(body).toMatchObject({ total: 0, providers: [] });
  });

  it('rejects an empty or over-long q', async () => {
    expect((await get('/providers?q=')).status).toBe(400);
    expect((await get(`/providers?q=${'a'.repeat(65)}`)).status).toBe(400);
  });
});

describe('GET /countries', () => {
  it('counts active clinics per country and omits inactive ones', async () => {
    const { status, body } = await get('/countries');
    expect(status).toBe(200);
    expect(body.countries).toEqual([
      { code: 'NG', clinicCount: 1 },
      { code: 'TZ', clinicCount: 1 },
    ]);
  });
});

describe('GET /services', () => {
  it('aggregates active services by code across active clinics', async () => {
    const { status, body } = await get('/services');
    expect(status).toBe(200);
    expect(body.total).toBe(3);

    const byCode = (code: number) =>
      body.services.find((s: { code: number }) => s.code === code);

    const consult = byCode(101);
    expect(consult).toMatchObject({
      labels: ['General consultation', 'Outpatient consult'],
      clinicCount: 2,
      minPrice: '30000000',
      maxPrice: '40000000',
      medianPrice: '35000000',
    });
    expect(consult.minPriceDisplay).toBe('3.0000000');
    expect(consult.medianPriceDisplay).toBe('3.5000000');

    expect(byCode(202)).toMatchObject({
      labels: ['Malaria rapid test'],
      clinicCount: 2,
      minPrice: '10000000',
      maxPrice: '15000000',
      medianPrice: '12500000',
    });

    expect(byCode(404)).toMatchObject({
      labels: ['Dental cleaning'],
      clinicCount: 1,
      minPrice: '20000000',
      maxPrice: '20000000',
      medianPrice: '20000000',
    });

    expect(byCode(303)).toBeUndefined();
  });

  it('lists one entry per code, ascending', async () => {
    const { body } = await get('/services');
    expect(body.services.map((s: { code: number }) => s.code)).toEqual([101, 202, 404]);
  });
});

describe('GET /services/:code', () => {
  it('lists the active clinics offering a code, cheapest first', async () => {
    const { status, body } = await get('/services/101');
    expect(status).toBe(200);
    expect(body.code).toBe(101);
    expect(body.clinicCount).toBe(2);
    expect(body.clinics.map((c: { name: string }) => c.name)).toEqual([
      'Ikeja General Clinic',
      'Mwanza Mission Hospital',
    ]);
    expect(body.clinics[0]).toMatchObject({
      address: CLINIC,
      country: 'NG',
      price: '30000000',
      priceDisplay: '3.0000000',
    });
  });

  it('404s a code only offered by an inactive service', async () => {
    const { status, body } = await get('/services/303');
    expect(status).toBe(404);
    expect(body.error).toBe('service_not_found');
  });

  it('404s an unknown code', async () => {
    expect((await get('/services/999')).status).toBe(404);
  });

  it('400s a non-numeric code', async () => {
    const { status, body } = await get('/services/abc');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_code');
  });
});

describe('GET /vouchers', () => {
  it('requires at least one filter', async () => {
    const { status, body } = await get('/vouchers');
    expect(status).toBe(400);
    expect(body.error).toBe('filter_required');
  });

  it('rejects a malformed beneficiary reference', async () => {
    const { status } = await get('/vouchers?beneficiaryRef=not-hex');
    expect(status).toBe(400);
  });

  it('lists by funder, newest first, with pagination metadata', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=2`);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4']);
  });

  it('filters by beneficiary reference and status together', async () => {
    const { body } = await get(`/vouchers?beneficiaryRef=${REF}&status=Funded`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['2']);
  });

  it('resolves service labels, including delisted services and unknown codes', async () => {
    const { body } = await get(`/vouchers?provider=${CLINIC}`);
    const label = (id: string) =>
      body.vouchers.find((v: { id: string }) => v.id === id).serviceLabel;
    expect(label('1')).toBe('Outpatient consult');
    expect(label('3')).toBe('Antenatal visit');
    expect(label('5')).toBeNull();
  });

  it('derives settle and refund flags from the contract rules', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}`);
    const v = (id: string) => body.vouchers.find((x: { id: string }) => x.id === id);

    expect(v('2')).toMatchObject({ isRefundable: true, isSettleable: false });
    expect(v('3')).toMatchObject({ isRefundable: false, isSettleable: false });
    expect(new Date(v('3').refundableAt).getTime()).toBe(
      new Date(v('3').expiresAt).getTime() + CLAIM_GRACE_MS,
    );
    expect(v('4')).toMatchObject({ isRefundable: false, isSettleable: true, refundableAt: null });
    expect(v('1')).toMatchObject({ isRefundable: false, isSettleable: false, refundableAt: null });
  });

  it('carries the dispute reason', async () => {
    const { body } = await get('/vouchers?status=Disputed');
    expect(body.vouchers[0]).toMatchObject({ id: '5', disputeReason: 2 });
  });
});

describe('GET /vouchers sort', () => {
  it('defaults to newest first', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '3', '2']);
  });

  it('sorts by createdAt ascending', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=createdAt&order=asc`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['2', '3', '1', '4', '5']);
  });

  it('sorts by expiresAt descending', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=expiresAt&order=desc`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '3', '2']);
  });

  it('sorts amount numerically, not lexicographically', async () => {
    const now = Date.now();
    await prisma.voucher.create({
      data: {
        id: 'cheap',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '9000000',
        status: 'Funded',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + 10 * DAY),
      },
    });

    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=asc`);
    expect(body.total).toBe(6);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual([
      'cheap',
      '2',
      '1',
      '4',
      '5',
      '3',
    ]);

    const desc = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=desc`);
    expect(desc.body.vouchers.map((v: { id: string }) => v.id)).toEqual([
      '3',
      '5',
      '4',
      '1',
      '2',
      'cheap',
    ]);
  });

  it('paginates after sorting by amount', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=asc&limit=2&offset=1`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['1', '4']);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.total).toBe(5);
  });

  it('rejects an unknown sort or order', async () => {
    expect((await get(`/vouchers?funder=${FUNDER}&sort=price`)).status).toBe(400);
    expect((await get(`/vouchers?funder=${FUNDER}&order=up`)).status).toBe(400);
  });
});

describe('GET /vouchers.csv', () => {
  it('requires at least one filter, in the common error envelope', async () => {
    const { status, json } = await getCsv('/vouchers.csv');
    expect(status).toBe(400);
    expect(json()).toMatchObject({ error: 'filter_required' });
  });

  it('streams the filtered vouchers as a CSV attachment', async () => {
    const { status, headers, body } = await getCsv(`/vouchers.csv?funder=${FUNDER}`);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/csv');
    expect(headers['content-disposition']).toContain('attachment');
    expect(headers['cache-control']).toBe('no-store');

    const rows = parseCsv(body);
    const header = rows[0]!;
    expect(header).toContain('id');
    expect(header).toContain('amountDisplay');
    expect(header).toContain('serviceLabel');
    // Never a beneficiary reference column.
    expect(header).not.toContain('beneficiaryRef');

    const byId = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect([...byId.keys()].sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(byId.get('1')![header.indexOf('amount')]).toBe('30000000');
    expect(byId.get('1')![header.indexOf('amountDisplay')]).toBe('3.0000000');
    expect(byId.get('1')![header.indexOf('providerName')]).toBe('Ikeja General Clinic');
    expect(byId.get('2')![header.indexOf('status')]).toBe('Funded');
    expect(byId.get('5')![header.indexOf('disputeReason')]).toBe('2');
  });

  it('accepts the same filters as the JSON route', async () => {
    const byStatus = parseCsv((await getCsv('/vouchers.csv?status=Funded')).body);
    expect(byStatus.slice(1).map((r) => r[0])).toEqual(['2']);

    const byProvider = parseCsv((await getCsv(`/vouchers.csv?provider=${SECOND_CLINIC}`)).body);
    expect(byProvider).toHaveLength(1); // header only, nothing for this clinic
  });

  it('escapes commas, quotes and line breaks in cells', async () => {
    const tricky = 'G'.repeat(56);
    await prisma.provider.create({
      data: {
        address: tricky,
        name: 'Clinic "A", Ltd\nSecond line',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date(),
      },
    });
    await prisma.voucher.create({
      data: {
        id: 'csv-escape',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: tricky,
        serviceCode: 101,
        amount: '10000000',
        status: 'Funded',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      },
    });

    const { body } = await getCsv(`/vouchers.csv?provider=${tricky}`);
    const rows = parseCsv(body);
    expect(rows).toHaveLength(2);
    const nameColumn = rows[0]!.indexOf('providerName');
    expect(rows[1]![nameColumn]).toBe('Clinic "A", Ltd\nSecond line');
  });

  it('exports more rows than one batch, in cursor order, without gaps or repeats', async () => {
    // 501 rows is one past the 500-row batch size, so the export has to
    // continue from a cursor: a boundary that skipped or duplicated a row
    // would show up here.
    const now = Date.now();
    await prisma.voucher.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `bulk-${String(i).padStart(4, '0')}`,
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Funded',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + DAY),
      })),
    });

    const { status, body } = await getCsv(`/vouchers.csv?funder=${FUNDER}`);
    expect(status).toBe(200);

    const ids = parseCsv(body)
      .slice(1)
      .map((r) => r[0]!);
    expect(ids).toHaveLength(506); // 501 bulk + 5 seeded
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(506);
    expect(ids).toContain('bulk-0499'); // last row of the first 500-row batch
    expect(ids).toContain('bulk-0500'); // first row after the cursor boundary
  });
});

describe('GET /vouchers/:id', () => {
  it('includes the receipt for a settled voucher', async () => {
    const { body } = await get('/vouchers/1');
    expect(body.amountDisplay).toBe('3.0000000');
    expect(body.settledNet).toBe('29700000');
    expect(body.receipt).toMatchObject({ voucherId: '1', amount: '30000000' });
  });

  it('has a null receipt before settlement', async () => {
    const { body } = await get('/vouchers/2');
    expect(body.receipt).toBeNull();
  });

  it('404s an unknown voucher', async () => {
    const { status } = await get('/vouchers/404');
    expect(status).toBe(404);
  });
});

describe('GET /receipts', () => {
  it('returns care history and total spend for one beneficiary', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${REF}`);
    expect(body.total).toBe(2);
    expect(body.totalSpend).toBe('40000000');
    expect(body.totalSpendDisplay).toBe('4.0000000');
    expect(body.receipts.map((r: { voucherId: string }) => r.voucherId)).toEqual(['9', '1']);
    expect(body.receipts[0].serviceLabel).toBe('Malaria rapid test');
  });

  it('returns nothing for a reference with no receipts', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${OTHER_REF}`);
    expect(body).toMatchObject({ total: 0, totalSpend: '0', receipts: [] });
  });

  it('requires a beneficiary reference', async () => {
    const { status } = await get('/receipts');
    expect(status).toBe(400);
  });

  it('lists receipts by provider, omitting beneficiaryRef', async () => {
    const { body } = await get(`/receipts?provider=${CLINIC}`);
    expect(body.total).toBe(2);
    expect(body.totalSpend).toBe('40000000');
    expect(body.receipts.map((r: { voucherId: string }) => r.voucherId)).toEqual(['9', '1']);
    expect(body.receipts[0]).not.toHaveProperty('beneficiaryRef');
    expect(body.receipts[0].serviceLabel).toBe('Malaria rapid test');
  });

  it('requires exactly one of beneficiaryRef or provider', async () => {
    const { status, body } = await get('/receipts');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');

    const { status: s2, body: b2 } = await get(`/receipts?beneficiaryRef=${REF}&provider=${CLINIC}`);
    expect(s2).toBe(400);
    expect(b2.error).toBe('invalid_query');
  });
});

describe('GET /receipts/:voucherId', () => {
  it('returns a single receipt by voucherId without beneficiaryRef', async () => {
    const { body } = await get('/receipts/1');
    expect(body.voucherId).toBe('1');
    expect(body.amount).toBe('30000000');
    expect(body.amountDisplay).toBe('3.0000000');
    expect(body.serviceLabel).toBe('Outpatient consult');
    expect(body).not.toHaveProperty('beneficiaryRef');
  });

  it('404s for an unknown voucher', async () => {
    const { status, body } = await get('/receipts/999');
    expect(status).toBe(404);
    expect(body.error).toBe('receipt_not_found');
  });
});

describe('GET /vouchers', () => {
  it('accepts comma-separated status list', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&status=Claimed,Attested`);
    expect(body.vouchers.map((v: { id: string }) => v.id).sort()).toEqual(['3', '4']);
  });

  it('rejects invalid status values', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&status=Claimed,Invalid`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });
});

describe('GET /vouchers/due', () => {
  it('requires funder or provider', async () => {
    const { status, body } = await get('/vouchers/due?within=72h');
    expect(status).toBe(400);
    expect(body.error).toBe('filter_required');
  });

  it('rejects invalid within format', async () => {
    const { status, body } = await get(`/vouchers/due?funder=${FUNDER}&within=invalid`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('returns vouchers expiring, becoming refundable, or settleable within the window', async () => {
    // Use a fixed clock by seeding with specific dates
    const now = Date.now();
    
    // Add more vouchers for testing the due endpoint
    await prisma.voucher.createMany({
      data: [
        // Funded, expires in 48h -> should be in 72h window (refundable at expiry)
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-1',
          serviceCode: 101,
          amount: '30000000',
          status: 'Funded',
          createdAt: new Date(now - 10 * DAY),
          expiresAt: new Date(now + 48 * 60 * 60 * 1000),
        },
        // Claimed, expired 24h ago -> refundable in 6 days (outside 72h)
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-2',
          serviceCode: 101,
          amount: '30000000',
          status: 'Claimed',
          createdAt: new Date(now - 31 * DAY),
          expiresAt: new Date(now - 24 * 60 * 60 * 1000),
        },
        // Attested, dispute deadline in 24h -> settleable in window
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-3',
          serviceCode: 101,
          amount: '30000000',
          status: 'Attested',
          createdAt: new Date(now - 5 * DAY),
          expiresAt: new Date(now + 25 * DAY),
          disputeDeadline: new Date(now + 24 * 60 * 60 * 1000),
        },
        // Funded, expires in 10 days -> outside 72h window
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-4',
          serviceCode: 101,
          amount: '30000000',
          status: 'Funded',
          createdAt: new Date(now - 10 * DAY),
          expiresAt: new Date(now + 10 * DAY),
        },
      ],
    });

    // Use provider filter
    const { body } = await get(`/vouchers/due?provider=${CLINIC}&within=72h`);
    
    // Existing seeded vouchers: id '2' (refundable now) and '4' (settleable now) are in window
    // New vouchers: due-1 (expires in 48h) and due-3 (dispute deadline in 24h) are in window
    // Total expected: 4
    const ids = body.vouchers.map((v: { id: string }) => v.id).sort();
    expect(ids).toContain('due-1');
    expect(ids).toContain('due-3');
    expect(ids).toContain('2');
    expect(ids).toContain('4');
    expect(ids).not.toContain('due-2');
    expect(ids).not.toContain('due-4');
    
    expect(body.total).toBe(4);
  });
});

describe('GET /governance', () => {
  it('reports current and pending admin plus history for each contract', async () => {
    const { status, body } = await get('/governance');
    expect(status).toBe(200);

    const byName = (name: string) =>
      body.contracts.find((c: { contract: string }) => c.contract === name);

    expect(byName('registry')).toMatchObject({ currentAdmin: NEW_ADMIN, pendingAdmin: null });
    expect(byName('registry').history.map((h: { type: string }) => h.type)).toEqual([
      'Proposed',
      'Changed',
    ]);

    expect(byName('voucher')).toMatchObject({ currentAdmin: ADMIN, pendingAdmin: NEW_ADMIN });
    expect(byName('voucher').history).toHaveLength(1);

    expect(byName('receipt')).toMatchObject({
      currentAdmin: null,
      pendingAdmin: null,
      history: [],
    });
  });
});

describe('cursor pagination', () => {
  it('pages through vouchers with cursor', async () => {
    const { body: page1 } = await get(`/vouchers?funder=${FUNDER}&limit=2`);
    expect(page1.vouchers).toHaveLength(2);

    const cursor = encodeCursor(
      new Date(page1.vouchers[1].createdAt),
      page1.vouchers[1].id,
    );
    const { body: page2 } = await get(`/vouchers?funder=${FUNDER}&limit=2&cursor=${cursor}`);
    expect(page2.vouchers.length).toBeGreaterThan(0);

    const page1Ids = page1.vouchers.map((v: { id: string }) => v.id);
    const page2Ids = page2.vouchers.map((v: { id: string }) => v.id);
    expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([]);
  });

  it('returns null nextCursor on the last page', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=100`);
    expect(body.nextCursor).toBeUndefined();
  });

  it('rejects an invalid cursor', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&cursor=not-valid!!`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_cursor');
  });

  it('pages through providers with cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;

    // Page through all providers one at a time
    do {
      const url = cursor ? `/providers?limit=1&cursor=${cursor}` : '/providers?limit=1';
      const { body } = await get(url);
      expect(body.providers).toHaveLength(1);
      seen.push(body.providers[0].address);
      cursor = body.nextCursor;
    } while (cursor);

    // Should have visited every provider exactly once
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('pages through receipts with cursor', async () => {
    const { body: page1 } = await get(`/receipts?beneficiaryRef=${REF}&limit=1`);
    expect(page1.receipts).toHaveLength(1);

    const cursor = encodeCursor(
      new Date(page1.receipts[0].settledAt),
      page1.receipts[0].voucherId,
    );
    const { body: page2 } = await get(`/receipts?beneficiaryRef=${REF}&limit=1&cursor=${cursor}`);
    expect(page2.receipts).toHaveLength(1);
    expect(page2.receipts[0].voucherId).not.toBe(page1.receipts[0].voucherId);
  });

  it('sends Deprecation header when offset is used', async () => {
    const res = await app.inject({ method: 'GET', url: `/vouchers?funder=${FUNDER}&offset=1` });
    expect(res.headers['deprecation']).toBe('true');
  });
});

describe('GET /providers/:address/history', () => {
  it('returns status transitions oldest first', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/history`);
    expect(status).toBe(200);
    expect(body.history.map((h: { status: string }) => h.status)).toEqual([
      'Active',
      'Suspended',
      'Active',
    ]);
    expect(body.history.map((h: { ledger: number }) => h.ledger)).toEqual([10, 12, 14]);
  });

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}/history`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /providers/:address/services/:code/history', () => {
  it('returns price changes oldest first', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services/101/history`);
    expect(status).toBe(200);
    expect(body.history.map((h: { price: string }) => h.price)).toEqual([
      '30000000',
      '35000000',
    ]);
    expect(body.history[0].priceDisplay).toBe('3.0000000');
  });

  it('rejects a non-numeric service code', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services/abc/history`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_code');
  });
});
