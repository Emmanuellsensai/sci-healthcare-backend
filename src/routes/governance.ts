import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { CONTRACTS } from '../env.js';

type Row = {
  contractId: string;
  contract: string;
  kind: string;
  admin: string;
  pendingAdmin: string | null;
  ledger: number;
  occurredAt: Date;
};

/**
 * Who controls each contract, and how that changed.
 *
 * Admin handover is two-step (`propose_admin` then `accept_admin`), so a
 * contract can have a sitting admin, a nominated successor, both or
 * neither at any moment. The history is folded in ledger order so the
 * latest proposal or acceptance decides the current state.
 */
export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/governance', {
    schema: {
      tags: ['governance'],
      summary: 'Admin history for each contract',
      description: 'Who controls each contract, and how that changed.',
    },
  }, async () => {
    const events = await prisma.governanceEvent.findMany({
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    const byContract = new Map<string, Row[]>();
    for (const e of events) {
      const list = byContract.get(e.contract) ?? [];
      list.push(e);
      byContract.set(e.contract, list);
    }

    // Every contract is reported, even one that has never had an admin
    // event, so the absence itself is visible.
    const contracts = CONTRACTS.map(({ contract }) => {
      const history = byContract.get(contract) ?? [];
      byContract.delete(contract);
      return summarise(contract, history);
    });

    // Events from a contract id not in this deployment's config still
    // deserve to be shown rather than dropped.
    for (const [contract, history] of byContract) {
      contracts.push(summarise(contract, history));
    }

    return { contracts };
  });
}

function summarise(contract: string, history: Row[]) {
  let currentAdmin: string | null = null;
  let pendingAdmin: string | null = null;
  for (const e of history) {
    currentAdmin = e.admin;
    pendingAdmin = e.kind === 'Proposed' ? e.pendingAdmin : null;
  }

  return {
    contract,
    contractId: history[0]?.contractId ?? null,
    currentAdmin,
    pendingAdmin,
    history: history.map((e) => ({
      type: e.kind,
      admin: e.admin,
      pendingAdmin: e.pendingAdmin,
      ledger: e.ledger,
      occurredAt: e.occurredAt,
    })),
  };
}
