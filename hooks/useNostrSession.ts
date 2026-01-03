import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { isValidSecret } from "@/lib/nostr-crypto";
import { saveSessionSecret } from "@/lib/history";

export type SessionStatus = "idle" | "active" | "stale" | "invalid" | "unknown";

interface UseNostrSessionOptions {
  secret: string;
  sessionId?: string;
  onSessionStatusChange?: (status: SessionStatus) => void;
  takeoverGraceMs?: number;
}

interface UseNostrSessionResult {
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  ignoreRemoteUntil: number;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
}

const DEFAULT_TAKEOVER_GRACE_MS = 15000;

function getInitialStatus(secret: string): SessionStatus {
  if (!secret) return "unknown";
  if (!isValidSecret(secret)) return "invalid";
  return "idle";
}

function getInitialNotice(status: SessionStatus): string | null {
  if (status === "invalid") {
    return "Invalid secret. Check for typos.";
  }
  return null;
}

export function useNostrSession({
  secret,
  sessionId,
  onSessionStatusChange,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
}: UseNostrSessionOptions): UseNostrSessionResult {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    getInitialStatus(secret)
  );
  const [sessionNotice, setSessionNotice] = useState<string | null>(
    getInitialNotice(getInitialStatus(secret))
  );
  const [localSessionId] = useState(() => sessionId ?? uuidv4());
  const [ignoreRemoteUntil, setIgnoreRemoteUntil] = useState<number>(0);

  const prevStatusRef = useRef<SessionStatus>(sessionStatus);
  const staleNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSessionStatusChangeRef = useRef(onSessionStatusChange);

  useEffect(() => {
    onSessionStatusChangeRef.current = onSessionStatusChange;
  }, [onSessionStatusChange]);

  useEffect(() => {
    if (sessionStatus === "active" && secret) {
      void saveSessionSecret(secret);
    }
  }, [sessionStatus, secret]);

  useEffect(() => {
    const nextStatus = getInitialStatus(secret);
    setSessionStatus(nextStatus);
    setSessionNotice(getInitialNotice(nextStatus));
  }, [secret]);

  useEffect(() => {
    onSessionStatusChangeRef.current?.(sessionStatus);
  }, [sessionStatus]);

  useEffect(() => {
    if (prevStatusRef.current !== "stale" && sessionStatus === "stale") {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
      }
      staleNoticeTimerRef.current = setTimeout(() => {
        setSessionNotice("Another device is now active.");
        staleNoticeTimerRef.current = null;
      }, 0);
    }
    prevStatusRef.current = sessionStatus;
    return () => {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
        staleNoticeTimerRef.current = null;
      }
    };
  }, [sessionStatus]);

  const startTakeoverGrace = useCallback(() => {
    setIgnoreRemoteUntil(Date.now() + takeoverGraceMs);
  }, [takeoverGraceMs]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  return {
    sessionStatus,
    sessionNotice,
    localSessionId,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
  };
}
