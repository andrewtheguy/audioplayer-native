import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { HistoryEntry, HistoryPayload } from "@/lib/history";
import { encryptHistory, decryptHistory } from "@/lib/nostr-crypto";

export const RELAYS = [
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.nostr.net",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

const KIND_HISTORY = 30078;
const D_TAG = "audioplayer-v3";

const pool = new SimplePool();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

let poolClosed = false;
export function closePool(): void {
  if (poolClosed) return;
  poolClosed = true;
  pool.close(RELAYS);
}

interface ValidatedPayload {
  v: number;
  ephemeralPubKey: string;
  ciphertext: string;
}

function isValidPayload(value: unknown): value is ValidatedPayload {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.v === "number" &&
    typeof obj.ephemeralPubKey === "string" &&
    typeof obj.ciphertext === "string"
  );
}

function parseAndValidateEventContent(content: string): ValidatedPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new Error("Event content is not valid JSON. Data may be corrupted.");
  }

  if (!isValidPayload(payload)) {
    throw new Error(
      "Invalid payload structure: missing or invalid ephemeralPubKey/ciphertext fields"
    );
  }

  return payload;
}

function canSetOnError(
  value: unknown
): value is { onerror?: (err: unknown) => void } {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { onerror?: unknown };
  return typeof maybe.onerror === "undefined" || typeof maybe.onerror === "function";
}

export async function saveHistoryToNostr(
  history: HistoryEntry[],
  userPrivateKey: Uint8Array,
  userPublicKey: string,
  sessionId?: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const { ciphertext, ephemeralPubKey } = encryptHistory(history, userPublicKey, sessionId);

  const payload = JSON.stringify({
    v: 1,
    ephemeralPubKey,
    ciphertext,
  });

  const tags = [
    ["d", D_TAG],
    ["client", "audioplayer"],
  ];

  const event = finalizeEvent(
    {
      kind: KIND_HISTORY,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: payload,
    },
    userPrivateKey
  );

  try {
    throwIfAborted(signal);
    const publishPromises = pool.publish(RELAYS, event).map((promise, index) =>
      promise.catch((err) => {
        const relay = RELAYS[index] ?? "unknown relay";
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[nostr] publish failed on ${relay}: ${message}`);
        throw err;
      })
    );
    await Promise.any(publishPromises);
    throwIfAborted(signal);
  } catch (err) {
    if (err instanceof AggregateError) {
      const reasons = err.errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ");
      throw new Error(`Failed to publish to any relay: ${reasons}`);
    }
    throw new Error(
      `Failed to save to Nostr: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

export async function loadHistoryFromNostr(
  userPrivateKey: Uint8Array,
  userPublicKey: string,
  signal?: AbortSignal
): Promise<HistoryPayload | null> {
  throwIfAborted(signal);
  const events = await pool.querySync(
    RELAYS,
    {
      kinds: [KIND_HISTORY],
      authors: [userPublicKey],
      "#d": [D_TAG],
      limit: 1,
    }
  );
  throwIfAborted(signal);

  if (events.length === 0) {
    return null;
  }

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];

  const payload = parseAndValidateEventContent(latest.content);

  return decryptHistory(payload.ciphertext, payload.ephemeralPubKey, userPrivateKey);
}

export function subscribeToHistoryDetailed(
  userPublicKey: string,
  userPrivateKey: Uint8Array,
  onEvent: (payload: HistoryPayload) => void
): () => void {
  try {
    const sub = pool.subscribeMany(
      RELAYS,
      {
        kinds: [KIND_HISTORY],
        authors: [userPublicKey],
        "#d": [D_TAG],
      },
      {
        onevent: (event) => {
          try {
            const payload = parseAndValidateEventContent(event.content);
            const historyPayload = decryptHistory(
              payload.ciphertext,
              payload.ephemeralPubKey,
              userPrivateKey
            );

            onEvent(historyPayload);
          } catch (err) {
            console.error("Nostr history event handler failed:", err);
          }
        },
      }
    );

    if (canSetOnError(sub)) {
      sub.onerror = (err) => {
        console.error("Nostr history subscription error:", err);
      };
    }

    return () => {
      sub.close();
    };
  } catch (err) {
    console.error("Failed to subscribe to Nostr history:", err);
    return () => {};
  }
}

export interface MergeResult {
  merged: HistoryEntry[];
  addedFromCloud: number;
}

export function mergeHistory(
  local: HistoryEntry[],
  remote: HistoryEntry[]
): MergeResult {
  const localByUrl = new Map(local.map((e) => [e.url, e]));

  let addedFromCloud = 0;

  const merged = remote.map((remoteEntry) => {
    const localEntry = localByUrl.get(remoteEntry.url);
    if (!localEntry) {
      addedFromCloud++;
      return remoteEntry;
    }

    const localTimeParsed = new Date(localEntry.lastPlayedAt).getTime();
    const remoteTimeParsed = new Date(remoteEntry.lastPlayedAt).getTime();

    const localTime = Number.isFinite(localTimeParsed) ? localTimeParsed : -Infinity;
    const remoteTime = Number.isFinite(remoteTimeParsed) ? remoteTimeParsed : -Infinity;

    if (localTime === -Infinity && remoteTime === -Infinity) {
      return remoteEntry;
    }

    if (localTime > remoteTime) {
      return { ...remoteEntry, position: localEntry.position };
    }

    return remoteEntry;
  });

  return {
    merged,
    addedFromCloud,
  };
}
