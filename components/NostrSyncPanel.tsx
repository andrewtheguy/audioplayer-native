import { forwardRef, useEffect, useImperativeHandle } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { isValidSecret } from "@/lib/nostr-crypto";
import type { HistoryEntry } from "@/lib/history";
import { RELAYS } from "@/lib/nostr-sync";
import { useNostrSync } from "@/hooks/useNostrSync";
import type { SessionStatus } from "@/hooks/useNostrSession";

interface NostrSessionApi {
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  ignoreRemoteUntil: number;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
}

export interface NostrSyncPanelHandle {
  startSession: () => void;
  takeOverSession: () => void;
  refreshSession: () => void;
  syncNow: () => void;
}

interface NostrSyncPanelProps {
  secret: string;
  history: HistoryEntry[];
  session: NostrSessionApi;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
}

export const NostrSyncPanel = forwardRef<NostrSyncPanelHandle, NostrSyncPanelProps>(
  ({ secret, history, session, onHistoryLoaded, onTakeOver, onRemoteSync }, ref) => {
  const {
    status,
    message,
    performLoad,
    performInitialLoad,
    startSession,
    performSave,
  } = useNostrSync({
    history,
    secret,
    sessionStatus: session.sessionStatus,
    setSessionStatus: session.setSessionStatus,
    setSessionNotice: session.setSessionNotice,
    sessionId: session.localSessionId,
    ignoreRemoteUntil: session.ignoreRemoteUntil,
    onHistoryLoaded,
    onTakeOver,
    onRemoteSync,
  });

  const secretValid = isValidSecret(secret);
  const isBusy = status === "loading" || status === "saving";

  useEffect(() => {
    if (!secret || !secretValid) return;
    if (session.sessionStatus === "idle" || session.sessionStatus === "unknown") {
      performInitialLoad(secret);
    }
  }, [secret, secretValid, session.sessionStatus, performInitialLoad]);

  const handleStartSession = () => {
    if (isBusy) return;
    if (!secretValid) return;
    session.startTakeoverGrace();
    session.setSessionStatus("active");
    startSession(secret);
  };

  const handleTakeOver = () => {
    if (isBusy) return;
    if (!secretValid) return;
    session.startTakeoverGrace();
    session.setSessionStatus("active");
    performLoad(secret, true, true);
  };

  const handleRefresh = () => {
    if (isBusy) return;
    if (!secretValid) return;
    performInitialLoad(secret);
  };

  const handleManualSave = () => {
    if (isBusy) return;
    if (!secretValid) return;
    void performSave(secret, history).catch((err) => {
      console.error("Failed to save history:", err);
    });
  };

  useImperativeHandle(ref, () => ({
    startSession: handleStartSession,
    takeOverSession: handleTakeOver,
    refreshSession: handleRefresh,
    syncNow: handleManualSave,
  }));

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Nostr Sync</Text>
      <Text style={styles.meta}>Relays: {RELAYS.length}</Text>
      <Text style={styles.meta}>Session: {session.sessionStatus}</Text>
      {session.sessionNotice ? (
        <Text style={styles.notice}>{session.sessionNotice}</Text>
      ) : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}

      {!secretValid ? (
        <Text style={styles.notice}>Invalid secret. Please log in again.</Text>
      ) : null}

      <View style={styles.row}>
        {session.sessionStatus === "idle" || session.sessionStatus === "unknown" ? (
          <Pressable
            style={[styles.button, isBusy && styles.buttonDisabled]}
            onPress={handleStartSession}
            disabled={isBusy}
          >
            <Text style={styles.buttonText}>Start Session</Text>
          </Pressable>
        ) : null}

        {session.sessionStatus === "stale" ? (
          <Pressable
            style={[styles.button, isBusy && styles.buttonDisabled]}
            onPress={handleTakeOver}
            disabled={isBusy}
          >
            <Text style={styles.buttonText}>Take Over</Text>
          </Pressable>
        ) : null}

        {session.sessionStatus === "active" ? (
          <Pressable
            style={[styles.button, isBusy && styles.buttonDisabled]}
            onPress={handleManualSave}
            disabled={isBusy}
          >
            <Text style={styles.buttonText}>Sync Now</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.meta}>Status: {status}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#111827",
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  },
  title: {
    color: "#F9FAFB",
    fontSize: 16,
    fontWeight: "600",
  },
  meta: {
    color: "#9CA3AF",
    marginTop: 6,
  },
  notice: {
    color: "#FCA5A5",
    marginTop: 6,
  },
  message: {
    color: "#93C5FD",
    marginTop: 6,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  row: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  button: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buttonText: {
    color: "#F9FAFB",
    fontWeight: "600",
  },
});

NostrSyncPanel.displayName = "NostrSyncPanel";
