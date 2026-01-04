import type { SessionStatus } from "@/hooks/useNostrSession";
import type { HistoryEntry, HistoryPayload } from "@/lib/history";
import { deriveNostrKeys } from "@/lib/nostr-crypto";
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
  secret: string;
  sessionStatus: SessionStatus;
  setSessionStatus: (status: SessionStatus) => void;
  sessionId: string;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  debounceSaveMs?: number;
}

interface UseNostrSyncResult {
  status: "idle" | "loading" | "saving" | "synced" | "error";
  message: string | null;
  performLoad: (secret: string, followRemote?: boolean) => (() => void) | undefined;
  performInitialLoad: (secret: string) => void;
  startSession: (secret: string) => void;
  performSave: (
    secret: string,
    historyToSave: HistoryEntry[],
    options?: { silent?: boolean }
  ) => Promise<void>;
}

const DEFAULT_DEBOUNCE_SAVE_MS = 5000;

export function useNostrSync({
  history,
  secret,
  sessionStatus,
  setSessionStatus,
  sessionId,
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
  const onHistoryLoadedRef = useRef(onHistoryLoaded);
  const onRemoteSyncRef = useRef(onRemoteSync);
  const sessionStatusRef = useRef(sessionStatus);
  const setSessionStatusRef = useRef(setSessionStatus);

  const isLocalChangeRef = useRef(false);
  const pendingPublishRef = useRef(false);
  const latestTimestampRef = useRef(0);

  useEffect(() => {
    historyRef.current = history;
    onHistoryLoadedRef.current = onHistoryLoaded;
    onRemoteSyncRef.current = onRemoteSync;
    sessionStatusRef.current = sessionStatus;
    setSessionStatusRef.current = setSessionStatus;
  }, [
    history,
    onHistoryLoaded,
    onRemoteSync,
    sessionStatus,
    setSessionStatus,
  ]);

  const performSave = useCallback(
    async (
      currentSecret: string,
      historyToSave: HistoryEntry[],
      options?: { silent?: boolean }
    ) => {
      if (!currentSecret) return;
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
        const keys = await deriveNostrKeys(currentSecret, signal);
        await saveHistoryToNostr(historyToSave, keys.privateKey, keys.publicKey, sessionId, signal);
        latestTimestampRef.current = Date.now();
        setStatus("synced");
        setMessage(`Saved ${historyToSave.length} entries`);
        dirtyRef.current = false;
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
    (currentSecret: string, followRemote = false) => {
      if (!currentSecret) return;

      const controller = new AbortController();
      const { signal } = controller;

      (async () => {
        try {
          setStatus("loading");
          setMessage("Loading history...");
          const keys = await deriveNostrKeys(currentSecret, signal);
          const cloudData = await loadHistoryFromNostr(keys.privateKey, keys.publicKey, signal);

          if (cloudData) {
            const { history: cloudHistory, timestamp } = cloudData;
            if (timestamp > latestTimestampRef.current) {
              latestTimestampRef.current = timestamp;
            }
            const result = mergeAndNotify(cloudHistory, followRemote);
            if (sessionStatusRef.current === "active") {
              setStatus("synced");
              setMessage(
                result.addedFromCloud > 0
                  ? `Merged ${result.addedFromCloud} remote entries`
                  : "History is up to date"
              );
            }
          } else {
            setStatus("synced");
            setMessage("No synced history found.");
            if (sessionStatusRef.current === "active") {
              try {
                await performSave(currentSecret, historyRef.current, { silent: true });
              } catch (err) {
                console.error("Failed to save history after load:", err);
                setStatus("error");
                setMessage(err instanceof Error ? err.message : "Failed to save history");
                return;
              }
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

  const performInitialLoad = useCallback(
    (currentSecret: string) => {
      if (!currentSecret) return;
      const controller = new AbortController();
      const { signal } = controller;

      (async () => {
        try {
          setStatus("loading");
          setMessage("Loading history...");
          const keys = await deriveNostrKeys(currentSecret, signal);
          const cloudData = await loadHistoryFromNostr(keys.privateKey, keys.publicKey, signal);

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

      return () => controller.abort();
    },
    []
  );

  const startSession = useCallback(
    (currentSecret: string) => {
      if (!currentSecret) return;
      sessionStatusRef.current = "active";
      setSessionStatusRef.current("active");
      performLoad(currentSecret, true);
    },
    [performLoad]
  );

  useEffect(() => {
    if (!secret) return;
    if (sessionStatus === "invalid") return;
    if (appState !== "active") return;

    let cleanup: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const keys = await deriveNostrKeys(secret);
        if (cancelled) return;
        cleanup = subscribeToHistoryDetailed(
          keys.publicKey,
          keys.privateKey,
          (payload: HistoryPayload) => {
            if (payload.sessionId && payload.sessionId === sessionId) return;
            if (payload.timestamp <= latestTimestampRef.current) return;
            latestTimestampRef.current = payload.timestamp;
            if (isLocalChangeRef.current) return;

            const result = mergeHistory(historyRef.current, payload.history);
            onHistoryLoadedRef.current(result.merged);
            onRemoteSyncRef.current?.(payload.history);
          }
        );
      } catch (err) {
        console.error("Failed to subscribe to Nostr history:", err);
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [secret, sessionId, appState, sessionStatus]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
      if (nextState === "active" && secret && sessionStatus !== "invalid") {
        performLoad(secret, true);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [performLoad, secret, sessionStatus]);

  useEffect(() => {
    if (!secret) return;
    if (sessionStatus !== "active") return;

    const timer = setTimeout(() => {
      void performSave(secret, historyRef.current, { silent: true }).catch((err) => {
        console.error("Failed to save history in background:", err);
      });
    }, debounceSaveMs);

    return () => clearTimeout(timer);
  }, [history, secret, sessionStatus, performSave, debounceSaveMs]);

  return {
    status,
    message,
    performLoad,
    performInitialLoad,
    startSession,
    performSave,
  };
}
