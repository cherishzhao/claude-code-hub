import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { logger } from "@/lib/logger";
import {
  acquireLeaderLock,
  type LeaderLock,
  releaseLeaderLock,
  startLeaderLockKeepAlive,
} from "@/lib/provider-endpoints/leader-lock";
import { getSystemSettings } from "@/repository/system-config";

const LOCK_KEY = "locks:query-log-cleanup";
const CLEANUP_BATCH_SIZE = 5000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 5 * 60 * 1000;

const cleanupState = globalThis as unknown as {
  __CCH_QUERY_LOG_CLEANUP_STARTED__?: boolean;
  __CCH_QUERY_LOG_CLEANUP_INTERVAL_ID__?: ReturnType<typeof setInterval>;
  __CCH_QUERY_LOG_CLEANUP_LOCK__?: LeaderLock;
  __CCH_QUERY_LOG_CLEANUP_RUNNING__?: boolean;
};

async function deleteQueryLogsBeforeDateBatch(
  beforeDate: Date,
  batchSize: number
): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM query_log WHERE id IN (
      SELECT id FROM query_log WHERE created_at < ${beforeDate} LIMIT ${batchSize}
    )`
  );
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

async function runCleanupOnce(): Promise<void> {
  if (cleanupState.__CCH_QUERY_LOG_CLEANUP_RUNNING__) {
    return;
  }

  cleanupState.__CCH_QUERY_LOG_CLEANUP_RUNNING__ = true;

  let lock: LeaderLock | null = null;
  let leadershipLost = false;
  let stopKeepAlive: (() => void) | undefined;

  try {
    const settings = await getSystemSettings();
    const retentionDays = settings.queryLogRetentionDays ?? 30;

    if (retentionDays <= 0) {
      return;
    }

    lock = await acquireLeaderLock(LOCK_KEY, LOCK_TTL_MS);
    if (!lock) {
      return;
    }

    cleanupState.__CCH_QUERY_LOG_CLEANUP_LOCK__ = lock;

    stopKeepAlive = startLeaderLockKeepAlive({
      getLock: () => cleanupState.__CCH_QUERY_LOG_CLEANUP_LOCK__,
      clearLock: () => {
        cleanupState.__CCH_QUERY_LOG_CLEANUP_LOCK__ = undefined;
      },
      ttlMs: LOCK_TTL_MS,
      logTag: "QueryLogCleanup",
      onLost: () => {
        leadershipLost = true;
      },
    }).stop;

    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const beforeDate = new Date(Date.now() - retentionMs);

    let totalDeleted = 0;
    while (true) {
      if (leadershipLost) {
        return;
      }

      const deleted = await deleteQueryLogsBeforeDateBatch(beforeDate, CLEANUP_BATCH_SIZE);

      if (deleted <= 0) {
        break;
      }

      totalDeleted += deleted;

      if (deleted < CLEANUP_BATCH_SIZE) {
        break;
      }
    }

    if (totalDeleted > 0) {
      logger.info("[QueryLogCleanup] Completed", {
        retentionDays,
        totalDeleted,
      });
    }
  } catch (error) {
    logger.warn("[QueryLogCleanup] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    stopKeepAlive?.();
    cleanupState.__CCH_QUERY_LOG_CLEANUP_RUNNING__ = false;

    if (lock) {
      cleanupState.__CCH_QUERY_LOG_CLEANUP_LOCK__ = undefined;
      await releaseLeaderLock(lock);
    }
  }
}

export function startQueryLogCleanup(): void {
  if (process.env.CI === "true") {
    return;
  }

  if (cleanupState.__CCH_QUERY_LOG_CLEANUP_STARTED__) {
    return;
  }

  cleanupState.__CCH_QUERY_LOG_CLEANUP_STARTED__ = true;

  void runCleanupOnce();

  cleanupState.__CCH_QUERY_LOG_CLEANUP_INTERVAL_ID__ = setInterval(() => {
    void runCleanupOnce();
  }, CLEANUP_INTERVAL_MS);
}

export function stopQueryLogCleanup(): void {
  const intervalId = cleanupState.__CCH_QUERY_LOG_CLEANUP_INTERVAL_ID__;
  if (intervalId) {
    clearInterval(intervalId);
  }

  cleanupState.__CCH_QUERY_LOG_CLEANUP_INTERVAL_ID__ = undefined;
  cleanupState.__CCH_QUERY_LOG_CLEANUP_STARTED__ = false;
  cleanupState.__CCH_QUERY_LOG_CLEANUP_RUNNING__ = false;

  const lock = cleanupState.__CCH_QUERY_LOG_CLEANUP_LOCK__;
  cleanupState.__CCH_QUERY_LOG_CLEANUP_LOCK__ = undefined;
  if (lock) {
    void releaseLeaderLock(lock);
  }
}
