import AsyncStorage from "@react-native-async-storage/async-storage";

export const STORAGE_KEY = "com.audioplayer.history.v1";
export const HISTORY_TIMESTAMP_KEY = "com.audioplayer.history.timestamp";
export const SESSION_SECRET_KEY = "com.audioplayer.session.secret";

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
  return (
    typeof entry.url === "string" &&
    (entry.title === undefined || typeof entry.title === "string") &&
    typeof entry.lastPlayedAt === "string" &&
    typeof entry.position === "number" &&
    (entry.gain === undefined || typeof entry.gain === "number")
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

export async function saveHistory(history: HistoryEntry[]): Promise<void> {
  try {
    const trimmed = trimHistory(history);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    await AsyncStorage.setItem(HISTORY_TIMESTAMP_KEY, Date.now().toString());
  } catch (err) {
    console.warn("Failed to save history to AsyncStorage:", err);
  }
}

export async function getSavedSessionSecret(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(SESSION_SECRET_KEY)) ?? "";
  } catch (err) {
    console.warn("Failed to read session secret:", err);
    return "";
  }
}

export async function saveSessionSecret(secret: string): Promise<void> {
  try {
    await AsyncStorage.setItem(SESSION_SECRET_KEY, secret);
  } catch (err) {
    console.warn("Failed to save session secret:", err);
  }
}

export async function clearSessionSecret(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SESSION_SECRET_KEY);
  } catch (err) {
    console.warn("Failed to clear session secret:", err);
  }
}
