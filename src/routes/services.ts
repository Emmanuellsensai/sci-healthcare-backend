import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { ApiError } from '../lib/errors.js';

type CatalogueRow = {
  code: number;
  label: string;
  price: string;
  providerAddress: string;
};

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/services', async () => {
    const rows = await prisma.service.findMany({
      where: { active: true, provider: { status: 'Active' } },
      select: { code: true, label: true, price: true, providerAddress: true },
    });

    const byCode = new Map<number, CatalogueRow[]>();
    for (const row of rows) {
      const group = byCode.get(row.code);
      if (group) group.push(row);
      else byCode.set(row.code, [row]);
    }

    const services = [...byCode.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, group]) => {
        const prices = group.map((row) => BigInt(row.price));
        const min = prices.reduce((a, b) => (b < a ? b : a));
        const max = prices.reduce((a, b) => (b > a ? b : a));
        const med = median(prices);
        return {
          code,
          labels: [...new Set(group.map((row) => row.label))].sort(),
          clinicCount: new Set(group.map((row) => row.providerAddress)).size,
          minPrice: min.toString(),
          maxPrice: max.toString(),
          medianPrice: med.toString(),
          minPriceDisplay: fromBaseUnits(min.toString()),
          maxPriceDisplay: fromBaseUnits(max.toString()),
          medianPriceDisplay: fromBaseUnits(med.toString()),
        };
      });

    return { total: services.length, services };
  });

  app.get('/services/:code', async (req) => {
    const { code } = req.params as { code: string };
    const serviceCode = Number(code);
    if (!Number.isInteger(serviceCode) || serviceCode < 0) {
      throw new ApiError(400, 'invalid_code', 'code must be a non-negative integer');
    }

    const rows = await prisma.service.findMany({
      where: { code: serviceCode, active: true, provider: { status: 'Active' } },
      include: { provider: { select: { address: true, name: true, country: true } } },
    });
    if (rows.length === 0) throw new ApiError(404, 'service_not_found', 'Service not found');

    const clinics = rows
      .map((row) => ({
        address: row.provider.address,
        name: row.provider.name,
        country: row.provider.country,
        price: row.price,
        priceDisplay: fromBaseUnits(row.price),
      }))
      .sort((a, b) => {
        const av = BigInt(a.price);
        const bv = BigInt(b.price);
        if (av === bv) return 0;
        return av < bv ? -1 : 1;
      });

    return { code: serviceCode, clinicCount: clinics.length, clinics };
  });
}

function median(prices: bigint[]): bigint {
  const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
