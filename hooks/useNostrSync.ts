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

interface UseNostrSyncOptions {
  history: HistoryEntry[];
  secret: string;
  sessionStatus: SessionStatus;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  sessionId: string;
  ignoreRemoteUntil: number;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  debounceSaveMs?: number;
}

interface UseNostrSyncResult {
  status: "idle" | "loading" | "saving" | "synced" | "error";
  message: string | null;
  performLoad: (
    secret: string,
    isTakeOver?: boolean,
    followRemote?: boolean
  ) => (() => void) | undefined;
  performInitialLoad: (secret: string) => void;
  startSession: (secret: string) => void;
  performSave: (
    secret: string,
    historyToSave: HistoryEntry[],
    options?: { silent?: boolean; allowStale?: boolean }
  ) => Promise<void>;
}

const DEFAULT_DEBOUNCE_SAVE_MS = 5000;

export function useNostrSync({
  history,
  secret,
  sessionStatus,
  setSessionStatus,
  setSessionNotice,
  sessionId,
  ignoreRemoteUntil,
  onHistoryLoaded,
  onTakeOver,
  onRemoteSync,
  debounceSaveMs = DEFAULT_DEBOUNCE_SAVE_MS,
}: UseNostrSyncOptions): UseNostrSyncResult {
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "synced" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);

  const historyRef = useRef(history);
  const onHistoryLoadedRef = useRef(onHistoryLoaded);
  const onTakeOverRef = useRef(onTakeOver);
  const onRemoteSyncRef = useRef(onRemoteSync);
  const sessionStatusRef = useRef(sessionStatus);
  const ignoreRemoteUntilRef = useRef(ignoreRemoteUntil);
  const setSessionStatusRef = useRef(setSessionStatus);
  const setSessionNoticeRef = useRef(setSessionNotice);

  const isLocalChangeRef = useRef(false);
  const pendingPublishRef = useRef(false);
  const latestTimestampRef = useRef(0);
  const dirtyRef = useRef(false);

  useEffect(() => {
    historyRef.current = history;
    onHistoryLoadedRef.current = onHistoryLoaded;
    onTakeOverRef.current = onTakeOver;
    onRemoteSyncRef.current = onRemoteSync;
    sessionStatusRef.current = sessionStatus;
    ignoreRemoteUntilRef.current = ignoreRemoteUntil;
    setSessionStatusRef.current = setSessionStatus;
    setSessionNoticeRef.current = setSessionNotice;
    dirtyRef.current = true;
  }, [
    history,
    onHistoryLoaded,
    onTakeOver,
    onRemoteSync,
    sessionStatus,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
  ]);

  const performSave = useCallback(
    async (
      currentSecret: string,
      historyToSave: HistoryEntry[],
      options?: { silent?: boolean; allowStale?: boolean }
    ) => {
      if (!currentSecret) return;
      if (pendingPublishRef.current) return;
      if (sessionStatusRef.current === "stale" && !options?.allowStale) return;
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
    (cloudHistory: HistoryEntry[], isTakeOver: boolean, followRemote: boolean) => {
      const result = mergeHistory(historyRef.current, cloudHistory);
      onHistoryLoadedRef.current(result.merged);

      if (isTakeOver) {
        onTakeOverRef.current?.(cloudHistory);
      } else if (followRemote) {
        onRemoteSyncRef.current?.(cloudHistory);
      }

      return result;
    },
    []
  );

  const updateSessionStateAndMaybeSave = useCallback(
    (result: { merged: HistoryEntry[]; addedFromCloud: number }, isTakeOver: boolean) => {
      if (sessionStatusRef.current === "active") {
        setStatus("synced");
        setMessage(
          result.addedFromCloud > 0
            ? `Merged ${result.addedFromCloud} remote entries`
            : "History is up to date"
        );
      }

      if (isTakeOver) {
        setStatus("synced");
        setMessage("Session claimed. Auto-save enabled.");
      }
    },
    []
  );

  const performLoad = useCallback(
    (currentSecret: string, isTakeOver = false, followRemote = false) => {
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
            const { history: cloudHistory, sessionId: remoteSid, timestamp } = cloudData;
            if (timestamp > latestTimestampRef.current) {
              latestTimestampRef.current = timestamp;
            }

            if (
              !isTakeOver &&
              sessionStatusRef.current === "active" &&
              remoteSid &&
              remoteSid !== sessionId
            ) {
              sessionStatusRef.current = "stale";
              setSessionStatusRef.current("stale");
              setSessionNoticeRef.current("Another device is now active.");
              setStatus("error");
              setMessage("Another device is active. Take over to continue.");
              return;
            }

            const result = mergeAndNotify(cloudHistory, isTakeOver, followRemote);
            updateSessionStateAndMaybeSave(result, isTakeOver);

            if (isTakeOver) {
              try {
                await performSave(currentSecret, historyRef.current, { allowStale: true });
                sessionStatusRef.current = "active";
                setSessionStatusRef.current("active");
                setSessionNoticeRef.current(null);
              } catch (err) {
                console.error("Failed to save history after takeover:", err);
                setStatus("error");
                setMessage(
                  err instanceof Error ? err.message : "Failed to save history after takeover"
                );
                return;
              }
            }
          } else {
            setStatus("synced");
            setMessage("No synced history found.");
            if (isTakeOver || sessionStatusRef.current === "active") {
              try {
                await performSave(currentSecret, historyRef.current, { allowStale: true });
                if (isTakeOver) {
                  sessionStatusRef.current = "active";
                  setSessionStatusRef.current("active");
                  setSessionNoticeRef.current(null);
                }
              } catch (err) {
                console.error("Failed to save history after takeover:", err);
                setStatus("error");
                setMessage(
                  err instanceof Error ? err.message : "Failed to save history after takeover"
                );
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
    [mergeAndNotify, performSave, sessionId, updateSessionStateAndMaybeSave]
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
      setSessionNoticeRef.current(null);
      performLoad(currentSecret, true, true);
    },
    [performLoad]
  );

  useEffect(() => {
    if (!secret) return;

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

            const inGrace = Date.now() < ignoreRemoteUntilRef.current;
            const isForeignSession = payload.sessionId && payload.sessionId !== sessionId;

            if (isForeignSession && !inGrace && sessionStatusRef.current === "active") {
              sessionStatusRef.current = "stale";
              setSessionStatusRef.current("stale");
              setSessionNoticeRef.current("Another device is now active.");
            }

            if (payload.timestamp <= latestTimestampRef.current) return;
            latestTimestampRef.current = payload.timestamp;
            if (inGrace) return;
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
  }, [secret, sessionId]);

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
