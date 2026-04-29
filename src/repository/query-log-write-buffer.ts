import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { logger } from "@/lib/logger";

export type QueryLogEntry = {
  messageRequestId: number;
  userId: number;
  sessionId: string | null;
  requestSequence: number;
  model: string | null;
  endpoint: string | null;
  queryContent: string;
  queryFormat: string;
};

type BufferConfig = {
  flushIntervalMs: number;
  batchSize: number;
  maxPending: number;
};

const DEFAULT_CONFIG: BufferConfig = {
  flushIntervalMs: 500,
  batchSize: 50,
  maxPending: 2000,
};

function buildBatchInsertSql(entries: QueryLogEntry[]) {
  if (entries.length === 0) {
    return null;
  }

  const valueRows = entries.map(
    (e) =>
      sql`(${e.messageRequestId}, ${e.userId}, ${e.sessionId}, ${e.requestSequence}, ${e.model}, ${e.endpoint}, ${e.queryContent}, ${e.queryFormat}, NOW())`
  );

  return sql`
    INSERT INTO query_log (message_request_id, user_id, session_id, request_sequence, model, endpoint, query_content, query_format, created_at)
    VALUES ${sql.join(valueRows, sql`, `)}
  `;
}

class QueryLogWriteBuffer {
  private readonly config: BufferConfig;
  private readonly pending: QueryLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;
  private flushAgainAfterCurrent = false;
  private stopping = false;

  constructor(config: BufferConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  enqueue(entry: QueryLogEntry): void {
    if (this.pending.length >= this.config.maxPending) {
      logger.warn("[QueryLogWriteBuffer] Queue overflow, dropping incoming entry", {
        maxPending: this.config.maxPending,
        currentPending: this.pending.length,
      });
      return;
    }

    this.pending.push(entry);

    if (this.flushInFlight) {
      this.flushAgainAfterCurrent = true;
      return;
    }

    if (!this.stopping) {
      this.ensureFlushTimer();
    }

    if (this.pending.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  private ensureFlushTimer(): void {
    if (this.stopping || this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private takeBatch(): QueryLogEntry[] {
    return this.pending.splice(0, this.config.batchSize);
  }

  async flush(): Promise<void> {
    if (this.flushInFlight) {
      this.flushAgainAfterCurrent = true;
      return this.flushInFlight;
    }

    this.clearFlushTimer();

    this.flushInFlight = (async () => {
      do {
        this.flushAgainAfterCurrent = false;

        while (this.pending.length > 0) {
          const batch = this.takeBatch();
          const query = buildBatchInsertSql(batch);
          if (!query) {
            continue;
          }

          try {
            await db.execute(query);
          } catch (error) {
            logger.error("[QueryLogWriteBuffer] Flush failed, retrying once", {
              error: error instanceof Error ? error.message : String(error),
              batchSize: batch.length,
            });

            try {
              await db.execute(query);
            } catch (retryError) {
              logger.error("[QueryLogWriteBuffer] Retry failed, dropping batch", {
                error: retryError instanceof Error ? retryError.message : String(retryError),
                batchSize: batch.length,
              });
            }

            break;
          }
        }
      } while (this.flushAgainAfterCurrent);
    })().finally(() => {
      this.flushInFlight = null;
      if (this.pending.length > 0 && !this.stopping) {
        this.ensureFlushTimer();
      }
    });

    await this.flushInFlight;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearFlushTimer();
    await this.flush();
    if (this.pending.length > 0) {
      await this.flush();
    }
  }
}

let _buffer: QueryLogWriteBuffer | null = null;
let _bufferState: "running" | "stopping" | "stopped" = "running";

function getBuffer(): QueryLogWriteBuffer | null {
  if (!_buffer) {
    if (_bufferState !== "running") {
      return null;
    }
    _buffer = new QueryLogWriteBuffer();
  }
  return _buffer;
}

export function enqueueQueryLog(entry: QueryLogEntry): void {
  const buffer = getBuffer();
  if (!buffer) {
    return;
  }
  buffer.enqueue(entry);
}

export async function flushQueryLogWriteBuffer(): Promise<void> {
  if (!_buffer) {
    return;
  }
  await _buffer.flush();
}

export async function stopQueryLogWriteBuffer(): Promise<void> {
  if (_bufferState === "stopped") {
    return;
  }
  _bufferState = "stopping";

  if (!_buffer) {
    _bufferState = "stopped";
    return;
  }

  await _buffer.stop();
  _buffer = null;
  _bufferState = "stopped";
}
