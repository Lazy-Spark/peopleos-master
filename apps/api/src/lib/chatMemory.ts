import { Redis, type RedisOptions } from "ioredis";
import { ChatTurn, type ChatTurn as TChatTurn } from "@peopleos/schemas";
import { env } from "../env.js";

/**
 * Module 4 — conversational memory: a Redis-backed sliding window of the last
 * `MAX_TURNS` turns per chat session, with a `TTL` of 24h (spec: "Redis sliding
 * window last 10 turns per session"; "Session: 24h TTL; user can resume in same
 * session from any channel"). This is the LIVE working memory handed to the LLM as
 * `history`; the DURABLE record of every message lives in Postgres (ChatMessage).
 *
 * Keyed `chat:{sessionId}` as a Redis LIST (one JSON-encoded ChatTurn per element).
 * We `LTRIM` to the window after each append and bump the 24h TTL on every touch so
 * an active conversation never expires mid-flow but an abandoned one self-cleans.
 *
 * We use a DEDICATED ioredis client (not the BullMQ `queueConnection`): BullMQ tunes
 * its connection for blocking reads (`maxRetriesPerRequest: null`) and shares it
 * between the producer and worker; keeping chat memory on its own client avoids
 * coupling request-path latency to the queue's connection state.
 */

/** Sliding-window size — the last N turns (spec: 10). */
const MAX_TURNS = 10;

/** Session TTL in seconds — 24h (spec). Refreshed on every get/append. */
const TTL_SECONDS = 24 * 60 * 60;

function key(sessionId: string): string {
  return `chat:${sessionId}`;
}

const memoryOptions: RedisOptions = {
  // Bound retries so a Redis hiccup surfaces quickly on the request path rather than
  // hanging the chat call; the route treats memory as best-effort context.
  maxRetriesPerRequest: 2,
  lazyConnect: true,
};

const memoryConnection = new Redis(env.REDIS_URL, memoryOptions);

/** Tolerant parse of one stored list element back into a ChatTurn (skips corrupt rows). */
function parseTurn(raw: string): TChatTurn | null {
  try {
    const parsed = ChatTurn.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Return the session's sliding-window history (oldest → newest), at most `MAX_TURNS`
 * turns. Refreshes the TTL so reading an active session keeps it alive. Never throws
 * for a cache miss; memory is best-effort context, so any Redis error is swallowed and
 * an empty window is returned (the answer is still grounded in retrieved policy).
 */
export async function getHistory(sessionId: string): Promise<TChatTurn[]> {
  try {
    const raw = await memoryConnection.lrange(key(sessionId), -MAX_TURNS, -1);
    if (raw.length > 0) {
      await memoryConnection.expire(key(sessionId), TTL_SECONDS);
    }
    return raw
      .map(parseTurn)
      .filter((t): t is TChatTurn => t !== null);
  } catch {
    return [];
  }
}

/**
 * Append turns to the session window, trim to the last `MAX_TURNS`, and (re)set the
 * 24h TTL — atomically via a pipeline. Typically called with the [user, assistant]
 * pair for one exchange. Best-effort: a Redis failure is swallowed (the durable
 * ChatMessage rows are the source of truth).
 */
export async function appendTurns(sessionId: string, turns: TChatTurn[]): Promise<void> {
  if (turns.length === 0) return;
  const encoded = turns.map((t) => JSON.stringify(ChatTurn.parse(t)));
  try {
    await memoryConnection
      .multi()
      .rpush(key(sessionId), ...encoded)
      .ltrim(key(sessionId), -MAX_TURNS, -1)
      .expire(key(sessionId), TTL_SECONDS)
      .exec();
  } catch {
    // Swallow — memory is best-effort; the answer + the DB record are unaffected.
  }
}

/** Close the chat-memory connection (mirrors closeQueueConnection for graceful shutdown). */
export async function closeChatMemory(): Promise<void> {
  if (memoryConnection.status !== "end") {
    await memoryConnection.quit();
  }
}
