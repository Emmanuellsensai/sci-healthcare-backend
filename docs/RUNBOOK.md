# Runbook

## Indexer falls outside the RPC retention window

Soroban RPC retains roughly seven days of ledgers on testnet. If the
indexer is offline longer than that, its cursor points at a ledger the
RPC no longer has. The indexer detects this on the next cycle, marks
itself **degraded** (`gap = true` in `IndexerState`), and `/ready`
returns **503** with the gap details.

### Symptoms

- `/ready` returns 503 with `checks.indexer = "gap"`.
- The `checks.gap` object shows `cursorLedger` (where the indexer was)
  and `oldestAvailable` (the oldest ledger the RPC still has).

### Recovery options

#### Option A — Restore a database snapshot

If you have a database backup taken while the indexer was still within
the retention window:

1. Restore the backup.
2. Restart the indexer. It will resume from the snapshot's cursor.

#### Option B — Accept the gap and resume

If no snapshot is available and you can tolerate missing events in the
gap:

1. Update the cursor to the oldest available ledger:
   ```sql
   UPDATE IndexerState
   SET lastLedger = <oldestAvailable from /ready>,
       gap = false,
       gapOldestLedger = NULL,
       gapCursorLedger = NULL
   WHERE id = 1;
   ```
2. Restart the indexer. It picks up from the new cursor.
3. Events between the old cursor and the new one are permanently lost.

#### Option C — Full reindex

If the deploy ledger is within the retention window:

1. Delete the database.
2. Set `INDEXER_START_LEDGER` to the deploy ledger.
3. Start the service. The indexer rebuilds the read model from scratch.
