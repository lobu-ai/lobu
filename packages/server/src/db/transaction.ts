import { type DbClient, getDb } from './client';

/** Join a caller-owned transaction, or create one for a standalone mutation. */
export function withTransaction<T>(transaction: DbClient | undefined, mutate: (sql: DbClient) => Promise<T>): Promise<T> {
  return transaction ? mutate(transaction) : getDb().begin(mutate);
}
