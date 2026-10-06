// The only file that imports expo-sqlite. Not exercised by Jest (no SQLite there): tests use
// test/memory-queue-store.ts, which has the same behaviour behind the same interface.
import * as SQLite from 'expo-sqlite';
import type { QueueRow, QueueStore, RowPatch } from '@/lib/punch-queue';

const META =
  'id, seq, user_id, kind, status, attempts, error_code, error_message, created_at, updated_at';

export async function openSqliteStore(): Promise<QueueStore> {
  const db = await SQLite.openDatabaseAsync('worktrack-punches.db');
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS punch_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload BLOB
    );
  `);

  return {
    async insert(row, payload) {
      await db.runAsync(
        `INSERT INTO punch_queue (id, user_id, kind, status, created_at, updated_at, payload)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
        row.id,
        row.user_id,
        row.kind,
        row.created_at,
        new Date().toISOString(),
        payload,
      );
    },
    list: (userId) =>
      db.getAllAsync<QueueRow>(
        `SELECT ${META} FROM punch_queue WHERE user_id = ? ORDER BY seq`,
        userId,
      ),
    async payload(id) {
      const row = await db.getFirstAsync<{ payload: Uint8Array | null }>(
        'SELECT payload FROM punch_queue WHERE id = ?',
        id,
      );
      return row?.payload ?? null;
    },
    async update(id, patch: RowPatch) {
      const { wipe, ...columns } = patch;
      const sets = [...Object.keys(columns).map((column) => `${column} = ?`), 'updated_at = ?'];
      const values = [...Object.values(columns), new Date().toISOString()];
      if (wipe) sets.push('payload = NULL');
      await db.runAsync(`UPDATE punch_queue SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    },
    async remove(id) {
      await db.runAsync('DELETE FROM punch_queue WHERE id = ?', id);
    },
    async purge(before) {
      await db.runAsync(
        "DELETE FROM punch_queue WHERE status = 'synced' AND updated_at < ?",
        before,
      );
    },
  };
}
