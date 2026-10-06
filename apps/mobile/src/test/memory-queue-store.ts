// In-memory stand-in for lib/punch-sqlite.ts, installed by jest.setup.ts: the same QueueStore
// behaviour (oldest first by seq, payload kept apart from the metadata) without SQLite.
import type { QueueRow, QueueStore } from '@/lib/punch-queue';

type Stored = { row: QueueRow; payload: Uint8Array | null };

let rows: Stored[] = [];
let seq = 0;

export const memoryStore: QueueStore = {
  async insert(row, payload) {
    if (rows.some((stored) => stored.row.id === row.id))
      throw new Error('UNIQUE constraint failed');
    const now = new Date().toISOString();
    rows.push({
      row: {
        ...row,
        seq: ++seq,
        status: 'queued',
        attempts: 0,
        error_code: null,
        error_message: null,
        updated_at: now,
      },
      payload,
    });
  },
  async list(userId) {
    return rows
      .filter((stored) => stored.row.user_id === userId)
      .map((stored) => ({ ...stored.row }));
  },
  async payload(id) {
    return rows.find((stored) => stored.row.id === id)?.payload ?? null;
  },
  async update(id, { wipe, ...patch }) {
    const stored = rows.find((candidate) => candidate.row.id === id);
    if (!stored) return;
    Object.assign(stored.row, patch, { updated_at: new Date().toISOString() });
    if (wipe) stored.payload = null;
  },
  async remove(id) {
    rows = rows.filter((stored) => stored.row.id !== id);
  },
  async purge(before) {
    rows = rows.filter(
      (stored) => stored.row.status !== 'synced' || stored.row.updated_at >= before,
    );
  },
};

export const openSqliteStore = async () => memoryStore;
export const resetMemoryStore = () => {
  rows = [];
  seq = 0;
};
/** Test-only: replaces what is stored for a row (for example to simulate a corrupted blob). */
export const setStoredPayload = (id: string, payload: Uint8Array | null) => {
  const stored = rows.find((candidate) => candidate.row.id === id);
  if (stored) stored.payload = payload;
};
