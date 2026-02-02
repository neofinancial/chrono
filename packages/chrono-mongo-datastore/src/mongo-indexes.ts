import { TaskStatus } from '@neofinancial/chrono';
import type { Collection } from 'mongodb';

export const DEFAULT_EXPIRY_SECONDS: number = 60 * 60 * 24 * 30; // 30 days

export const IndexNames = {
  COMPLETED_DOCUMENT_TTL_INDEX: 'chrono-completed-document-ttl-index',
  CLAIM_DOCUMENT_INDEX: 'chrono-claim-document-index',
  IDEMPOTENCY_KEY_INDEX: 'chrono-idempotency-key-index',
};

export type IndexDefinitionOptions = {
  expireAfterSeconds?: number;
};

export async function ensureIndexes(collection: Collection, options: IndexDefinitionOptions): Promise<void> {
  await collection.createIndex(
    { completedAt: -1 },
    {
      partialFilterExpression: {
        completedAt: { $exists: true },
        status: { $eq: TaskStatus.COMPLETED },
      },
      expireAfterSeconds: options.expireAfterSeconds || DEFAULT_EXPIRY_SECONDS,
      name: IndexNames.COMPLETED_DOCUMENT_TTL_INDEX,
    },
  );

  await collection.createIndex(
    { kind: 1, status: 1, scheduledAt: 1, priority: -1, claimedAt: 1 },
    { name: IndexNames.CLAIM_DOCUMENT_INDEX },
  );

  await collection.createIndex(
    { idempotencyKey: 1 },
    { name: IndexNames.IDEMPOTENCY_KEY_INDEX, unique: true, sparse: true },
  );
}
