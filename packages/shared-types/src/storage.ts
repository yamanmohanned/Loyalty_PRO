import { z } from 'zod';

/**
 * Free space on the volume that holds the database (CLAUDE_v3.md §12.15).
 *
 * §12.15 established that a full system drive at a merchant is not a nuisance but an
 * outage, and that its symptom is misleading: SQLite fails writes cleanly rather than
 * corrupting, and reads keep working, so the dashboard renders perfectly while every
 * scan at the till errors. Nobody looks at free space until something breaks, and by
 * then the thing that broke is the sale in front of a waiting customer.
 *
 * So the number is put on screen before it matters. This module is the wire contract
 * for that: what the API measures, and what it pushes when the verdict changes.
 *
 * **The server classifies; no client re-derives the level.** The thresholds and the
 * hysteresis around them live in one place on the API side, because a client that
 * applied its own edges would disagree with the pushed events at exactly the boundary
 * where disagreement is most confusing.
 */

/**
 * The verdict on a volume.
 *
 * `UNKNOWN` is a real state, not a placeholder for "not measured yet". A volume that
 * cannot be measured — the path is gone, the call failed — must never be reported as
 * `OK`, which is the same mistake in miniature as an agent that reports healthy while
 * capturing nothing (§12.15).
 */
export const StorageLevelSchema = z.enum(['OK', 'WARN', 'CRITICAL', 'UNKNOWN']);
export type StorageLevel = z.infer<typeof StorageLevelSchema>;

export const StorageStatusSchema = z.object({
  level: StorageLevelSchema,
  /** Free bytes on the volume. Null only when the sample failed. */
  freeBytes: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  /**
   * The directory measured, so the answer to "which drive do I clear" is on screen
   * rather than in someone's memory of where the installer put things.
   */
  path: z.string(),
  /**
   * When this reading was taken.
   *
   * Carried rather than implied: the reading is produced by a sampler on a timer, and a
   * timestamp is what separates "the disk is fine" from "the last thing we heard was
   * that the disk was fine".
   */
  sampledAt: z.string(),
  /** Why the sample failed, when it did. Null otherwise. */
  error: z.string().nullable(),
});

export type StorageStatus = z.infer<typeof StorageStatusSchema>;
