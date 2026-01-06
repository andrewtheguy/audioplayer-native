import AsyncStorage from "@react-native-async-storage/async-storage";

export const STORAGE_KEY = "com.audioplayer.history.v1";
export const HISTORY_TIMESTAMP_KEY = "com.audioplayer.history.timestamp";

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
  timestamp: number;
  sessionId?: string;
}

function isValidHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const isValidIsoDateString = (dateValue: string): boolean => {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        dateValue
      )
    ) {
      return false;
    }
    return Number.isFinite(Date.parse(dateValue));
  };
  const hasValidPosition =
    typeof entry.position === "number" &&
    Number.isFinite(entry.position) &&
    entry.position >= 0;
  const hasValidLastPlayedAt =
    typeof entry.lastPlayedAt === "string" && isValidIsoDateString(entry.lastPlayedAt);
  const hasValidGain =
    entry.gain === undefined ||
    (typeof entry.gain === "number" &&
      Number.isFinite(entry.gain) &&
      entry.gain >= 0 &&
      entry.gain <= 1);
  return (
    typeof entry.url === "string" &&
    (entry.title === undefined || typeof entry.title === "string") &&
    hasValidLastPlayedAt &&
    hasValidPosition &&
    hasValidGain
  );
}

function validateHistoryArray(data: unknown): HistoryEntry[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const valid: HistoryEntry[] = [];
  for (const item of data) {
    if (isValidHistoryEntry(item)) {
      valid.push(item);
    }
  }
  return valid;
}

function trimHistory(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= MAX_HISTORY_ENTRIES) {
    return history;
  }
  return history.slice(0, MAX_HISTORY_ENTRIES);
}

export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    const validated = validateHistoryArray(parsed);
    return trimHistory(validated);
  } catch (err) {
    console.warn("Failed to parse history from AsyncStorage:", err);
    return [];
  }
}

export async function saveHistory(history: HistoryEntry[]): Promise<boolean> {
  try {
    const trimmed = trimHistory(history);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    await AsyncStorage.setItem(HISTORY_TIMESTAMP_KEY, Date.now().toString());
    return true;
  } catch (err) {
    console.warn("Failed to save history to AsyncStorage:", err);
    return false;
  }
}
