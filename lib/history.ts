import AsyncStorage from "@react-native-async-storage/async-storage";

export const STORAGE_KEY = "com.audioplayer.history.v1";

export const MAX_HISTORY_ENTRIES = 100;

export interface HistoryEntry {
  url: string;
  title?: string;
  lastPlayedAt: string;
  position: number;
  gain?: number;
}

export interface HistoryPayload {
  history: HistoryEntry[];
  timestamp: number; // Date.now() milliseconds
  sessionId?: string;
}

/**
 * Validate that a value is a valid HistoryEntry
 */
function isValidHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.url === "string" &&
    (entry.title === undefined || typeof entry.title === "string") &&
    typeof entry.lastPlayedAt === "string" &&
    typeof entry.position === "number" &&
    (entry.gain === undefined || typeof entry.gain === "number")
  );
}

/**
 * Validate and filter an array to only valid HistoryEntry items
 */
function validateHistoryArray(data: unknown): HistoryEntry[] {
  if (!Array.isArray(data)) {
    console.warn("History data is not an array, returning empty history");
    return [];
  }

  const valid: HistoryEntry[] = [];
  for (const item of data) {
    if (isValidHistoryEntry(item)) {
      valid.push(item);
    } else {
      console.warn("Skipping invalid history entry:", item);
    }
  }

  return valid;
}

/**
 * Trim history to MAX_HISTORY_ENTRIES, keeping most recent entries.
 * Assumes history is sorted with most recent first.
 */
function trimHistory(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= MAX_HISTORY_ENTRIES) {
    return history;
  }
  return history.slice(0, MAX_HISTORY_ENTRIES);
}

/**
 * Validate that a value is a valid HistoryPayload
 */
function isValidHistoryPayload(value: unknown): value is HistoryPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    Array.isArray(payload.history) &&
    typeof payload.timestamp === "number" &&
    (payload.sessionId === undefined || typeof payload.sessionId === "string")
  );
}

/**
 * Get history payload from AsyncStorage (atomic: history + timestamp together)
 * Returns null if no history exists or on parse error
 */
async function getHistoryPayload(): Promise<HistoryPayload | null> {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    if (!data) return null;

    const parsed: unknown = JSON.parse(data);

    if (!isValidHistoryPayload(parsed)) {
      console.warn("Invalid history format in AsyncStorage");
      return null;
    }

    const validated = validateHistoryArray(parsed.history);
    return {
      history: trimHistory(validated),
      timestamp: parsed.timestamp,
      sessionId: parsed.sessionId,
    };
  } catch (err) {
    console.warn("Failed to parse history from AsyncStorage:", err);
    return null;
  }
}

/**
 * Get history entries from AsyncStorage
 */
export async function getHistory(): Promise<HistoryEntry[]> {
  return (await getHistoryPayload())?.history ?? [];
}

/**
 * Get the timestamp when history was last saved
 * Returns null if no history exists
 */
export async function getHistoryTimestamp(): Promise<number | null> {
  return (await getHistoryPayload())?.timestamp ?? null;
}

/**
 * Save history payload to AsyncStorage (atomic: history + timestamp together)
 */
export async function saveHistory(
  history: HistoryEntry[],
  sessionId?: string
): Promise<boolean> {
  try {
    const trimmed = trimHistory(history);
    const payload: HistoryPayload = {
      history: trimmed,
      timestamp: Date.now(),
      sessionId,
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("Failed to save history to AsyncStorage:", err);
    return false;
  }
}

/**
 * Clear history from AsyncStorage
 */
export async function clearHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("Failed to clear history from AsyncStorage:", err);
  }
}
