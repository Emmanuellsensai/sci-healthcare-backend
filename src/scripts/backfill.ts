import { parseArgs } from 'node:util';

import pino from 'pino';

import { disconnect } from '../db.js';
import { env, INDEXED_CONTRACTS } from '../env.js';
import { server } from '../stellar/client.js';
import { decodeEvent, type DecodedEvent } from '../stellar/events.js';
import { Indexer } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
  },
  strict: true,
});

const from = Number(values.from);
if (!Number.isInteger(from) || from < 0) {
  console.error('--from <ledger> is required (non-negative integer)');
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  const health = await server.getHealth();

  if (from < health.oldestLedger) {
    console.error(
      `--from ${from} is older than the RPC's oldest available ledger ${health.oldestLedger}. ` +
        'The RPC cannot serve events that old.',
    );
    process.exit(1);
  }

  const to = values.to ? Number(values.to) : health.latestLedger;
  if (!Number.isInteger(to) || to < from) {
    console.error(`--to must be an integer >= --from (${from})`);
    process.exit(1);
  }

  log.info({ from, to, oldestLedger: health.oldestLedger }, 'backfill starting');

  const indexer = new Indexer(log);
  let startLedger = from;
  let totalApplied = 0;

  while (startLedger <= to) {
    const { events, throughLedger, hasMore } = await collectEvents(server, {
      startLedger,
      contractIds: INDEXED_CONTRACTS,
    });

    for (const raw of events) {
      if (raw.ledger > to) break;
      const decoded = decodeEvent(raw as never);
      if (!decoded) continue;
      try {
        await indexer.applyEvent(decoded);
        totalApplied += 1;
      } catch (err) {
        log.warn(
          { err, event: (decoded as DecodedEvent).name, ledger: (decoded as DecodedEvent).ledger },
          'backfill: event skipped',
        );
      }
    }

    if (totalApplied > 0 && totalApplied % 500 < events.length) {
      log.info({ applied: totalApplied, throughLedger }, 'backfill progress');
    }

    if (!hasMore || throughLedger >= to) break;
    startLedger = throughLedger + 1;
  }

  log.info({ totalApplied, from, to }, 'backfill complete');
  await disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
