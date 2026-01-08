import type { SessionStatus } from "@/hooks/useNostrSession";
import type { HistoryEntry, HistoryPayload } from "@/lib/history";
import type { NostrKeys } from "@/lib/nostr-crypto";
import {
  loadHistoryFromNostr,
  mergeHistory,
  saveHistoryToNostr,
  subscribeToHistoryDetailed,
} from "@/lib/nostr-sync";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

interface UseNostrSyncOptions {
  history: HistoryEntry[];
  encryptionKeys: NostrKeys | null;
  sessionStatus: SessionStatus;
  setSessionStatus: (status: SessionStatus) => void;
  sessionId: string;
  ignoreRemoteUntil: number;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  debounceSaveMs?: number;
}

interface UseNostrSyncResult {
  status: "idle" | "loading" | "saving" | "synced" | "error";
  message: string | null;
  performLoad: (isTakeOver?: boolean) => (() => void) | undefined;
  performInitialLoad: () => void;
  startSession: () => void;
  performSave: (
    historyToSave: HistoryEntry[],
    options?: { silent?: boolean }
  ) => Promise<void>;
}

const DEFAULT_DEBOUNCE_SAVE_MS = 5000;

export function useNostrSync({
  history,
  encryptionKeys,
  sessionStatus,
  setSessionStatus,
  sessionId,
  ignoreRemoteUntil,
  onHistoryLoaded,
  onRemoteSync,
  debounceSaveMs = DEFAULT_DEBOUNCE_SAVE_MS,
}: UseNostrSyncOptions): UseNostrSyncResult {
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "synced" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  const historyRef = useRef(history);
  const encryptionKeysRef = useRef(encryptionKeys);
  const onHistoryLoadedRef = useRef(onHistoryLoaded);
  const onRemoteSyncRef = useRef(onRemoteSync);
  const sessionStatusRef = useRef(sessionStatus);
  const setSessionStatusRef = useRef(setSessionStatus);
  const ignoreRemoteUntilRef = useRef(ignoreRemoteUntil);

  const isLocalChangeRef = useRef(false);
  const pendingPublishRef = useRef(false);
  const latestTimestampRef = useRef(0);
  const lastAppStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    historyRef.current = history;
    encryptionKeysRef.current = encryptionKeys;
    onHistoryLoadedRef.current = onHistoryLoaded;
    onRemoteSyncRef.current = onRemoteSync;
    sessionStatusRef.current = sessionStatus;
    setSessionStatusRef.current = setSessionStatus;
    ignoreRemoteUntilRef.current = ignoreRemoteUntil;
  }, [
    history,
    encryptionKeys,
    onHistoryLoaded,
    onRemoteSync,
    sessionStatus,
    setSessionStatus,
    ignoreRemoteUntil,
  ]);

  const performSave = useCallback(
    async (
      historyToSave: HistoryEntry[],
      options?: { silent?: boolean }
    ) => {
      const keys = encryptionKeysRef.current;
      if (!keys) return;
      if (pendingPublishRef.current) return;
      if (!options?.silent) {
        setStatus("saving");
        setMessage("Saving history...");
      }

      const controller = new AbortController();
      const { signal } = controller;
      try {
        pendingPublishRef.current = true;
        isLocalChangeRef.current = true;
        await saveHistoryToNostr(historyToSave, keys, sessionId, signal);
        latestTimestampRef.current = Date.now();
        setStatus("synced");
        setMessage(`Saved ${historyToSave.length} entries`);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error("Failed to save history");
        if (!options?.silent) {
          setStatus("error");
          setMessage(error.message);
        }
        throw error;
      } finally {
        isLocalChangeRef.current = false;
        pendingPublishRef.current = false;
      }
    },
    [sessionId]
  );

  const mergeAndNotify = useCallback(
    (cloudHistory: HistoryEntry[], followRemote: boolean) => {
      const result = mergeHistory(historyRef.current, cloudHistory);
      onHistoryLoadedRef.current(result.merged);

      if (followRemote) {
        onRemoteSyncRef.current?.(cloudHistory);
      }

      return result;
    },
    []
  );

  const performLoad = useCallback(
    (isTakeOver = false) => {
      const keys = encryptionKeysRef.current;
      if (!keys) return;

      const controller = new AbortController();
      const { signal } = controller;

      (async () => {
        try {
          setStatus("loading");
          setMessage(isTakeOver ? "Starting session..." : "Loading history...");
          const cloudData = await loadHistoryFromNostr(keys, signal);

          if (cloudData) {
            const { history: cloudHistory, timestamp } = cloudData;
            if (timestamp > latestTimestampRef.current) {
              latestTimestampRef.current = timestamp;
            }
            const result = mergeAndNotify(cloudHistory, isTakeOver);

            // When taking over, always save to publish new session ID
            if (isTakeOver) {
              setSessionStatusRef.current("active");
              sessionStatusRef.current = "active";
              try {
                await performSave(result.merged, { silent: false });
                setMessage("Session started");
              } catch (err) {
                console.error("Failed to publish session:", err);
                setStatus("error");
                setMessage(err instanceof Error ? err.message : "Failed to start session");
                return;
              }
            } else if (sessionStatusRef.current === "active") {
              setStatus("synced");
              setMessage(
                result.addedFromCloud > 0
                  ? `Merged ${result.addedFromCloud} remote entries`
                  : "History is up to date"
              );
            }
          } else {
            // No cloud data - save local history
            if (isTakeOver) {
              setSessionStatusRef.current("active");
              sessionStatusRef.current = "active";
            }
            if (sessionStatusRef.current === "active") {
              try {
                await performSave(historyRef.current, { silent: false });
                setMessage("Session started (new)");
              } catch (err) {
                console.error("Failed to save history after load:", err);
                setStatus("error");
                setMessage(err instanceof Error ? err.message : "Failed to save history");
                return;
              }
            } else {
              setStatus("synced");
              setMessage("No synced history found.");
            }
          }
        } catch (err) {
          setStatus("error");
          setMessage(err instanceof Error ? err.message : "Failed to load history");
        }
      })();

      return () => controller.abort();
    },
    [mergeAndNotify, performSave]
  );

  const performInitialLoad = useCallback(() => {
    const keys = encryptionKeysRef.current;
    if (!keys) return;

    (async () => {
      try {
        setStatus("loading");
        setMessage("Loading history...");
        const cloudData = await loadHistoryFromNostr(keys);

        if (cloudData) {
          const { history: cloudHistory, timestamp } = cloudData;
          if (timestamp > latestTimestampRef.current) {
            latestTimestampRef.current = timestamp;
          }
          const result = mergeHistory(historyRef.current, cloudHistory);
          onHistoryLoadedRef.current(result.merged);
          setStatus("synced");
          setMessage(`Loaded ${cloudHistory.length} entries`);
        } else {
          setStatus("synced");
          setMessage("No synced history found.");
        }
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Failed to load history");
      }
    })();
  }, []);

  const startSession = useCallback(() => {
    if (!encryptionKeysRef.current) return;
    // performLoad(true) will set status to active and publish session ID
    performLoad(true);
  }, [performLoad]);

  // Subscription effect
  useEffect(() => {
    if (!encryptionKeys) return;
    if (sessionStatus === "invalid" || sessionStatus === "no_npub" || sessionStatus === "needs_secret" || sessionStatus === "needs_setup") return;
    if (appState !== "active") return;

    let cleanup: (() => void) | null = null;

    try {
      cleanup = subscribeToHistoryDetailed(
        encryptionKeys,
        (payload: HistoryPayload) => {
          // Skip if this is our own session
          if (payload.sessionId && payload.sessionId === sessionId) return;
          // Skip if timestamp is older than what we have
          if (payload.timestamp <= latestTimestampRef.current) return;
          // Skip if within takeover grace period
          if (Date.now() < ignoreRemoteUntilRef.current) return;

          latestTimestampRef.current = payload.timestamp;
          if (isLocalChangeRef.current) return;

          // Detect session takeover - only transition to stale if currently active
          if (sessionStatusRef.current === "active" && payload.sessionId && payload.sessionId !== sessionId) {
            setSessionStatusRef.current("stale");
          }

          const result = mergeHistory(historyRef.current, payload.history);
          onHistoryLoadedRef.current(result.merged);
          onRemoteSyncRef.current?.(payload.history);
        }
      );
    } catch (err) {
      console.error("Failed to subscribe to Nostr history:", err);
    }

    return () => {
      cleanup?.();
    };
  }, [encryptionKeys, sessionId, appState, sessionStatus]);

  // App state change effect - refresh data when app comes to foreground
  // Note: resetPool is called by useNostrSession when app returns from background/inactive
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const wasNotActive = lastAppStateRef.current !== "active";
      lastAppStateRef.current = nextState;
      setAppState(nextState);

      // When returning to foreground (from background or inactive/locked), refresh data
      if (nextState === "active" && wasNotActive) {
        console.log("[useNostrSync] App became active, refreshing data");
        if (encryptionKeysRef.current && sessionStatusRef.current !== "invalid") {
          performLoad(false);
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [performLoad]);

  // Auto-save effect
  useEffect(() => {
    if (!encryptionKeys) return;
    if (sessionStatus !== "active") return;

    const timer = setTimeout(() => {
      void performSave(historyRef.current, { silent: true }).catch((err) => {
        console.error("Failed to save history in background:", err);
      });
    }, debounceSaveMs);

    return () => clearTimeout(timer);
  }, [history, encryptionKeys, sessionStatus, performSave, debounceSaveMs]);

  return {
    status,
    message,
    performLoad,
    performInitialLoad,
    startSession,
    performSave,
  };
}
