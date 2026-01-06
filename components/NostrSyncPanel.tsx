import type { SessionStatus } from "@/hooks/useNostrSession";
import { useNostrSync } from "@/hooks/useNostrSync";
import type { HistoryEntry } from "@/lib/history";
import type { NostrKeys } from "@/lib/nostr-crypto";
import { RELAYS } from "@/lib/nostr-sync";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface NostrSessionApi {
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  ignoreRemoteUntil: number;
  setSessionStatus: (status: SessionStatus) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
}

export interface NostrSyncPanelHandle {
  startSession: () => void;
  enterViewMode: () => void;
  refreshSession: () => void;
  syncNow: () => void;
}

interface NostrSyncPanelProps {
  encryptionKeys: NostrKeys | null;
  npub: string;
  fingerprint: string;
  history: HistoryEntry[];
  session: NostrSessionApi;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
}

export const NostrSyncPanel = forwardRef<NostrSyncPanelHandle, NostrSyncPanelProps>(
  ({ encryptionKeys, npub, fingerprint, history, session, onHistoryLoaded, onRemoteSync }, ref) => {
    const [npubFingerprint, setNpubFingerprint] = useState<string | null>(null);
    const [fingerprintStatus, setFingerprintStatus] = useState<string | null>(null);

    const hasKeys = encryptionKeys !== null;

    const {
      status,
      message,
      performInitialLoad,
      startSession,
      performSave,
    } = useNostrSync({
      history,
      encryptionKeys,
      sessionStatus: session.sessionStatus,
      setSessionStatus: session.setSessionStatus,
      sessionId: session.localSessionId,
      ignoreRemoteUntil: session.ignoreRemoteUntil,
      onHistoryLoaded,
      onRemoteSync,
    });

    const isBusy = status === "loading" || status === "saving";

    // Initial load when encryption keys are available
    useEffect(() => {
      if (!hasKeys) return;
      if (session.sessionStatus === "idle") {
        performInitialLoad();
      }
    }, [hasKeys, session.sessionStatus, performInitialLoad]);

    // Compute npub fingerprint for display
    useEffect(() => {
      if (!fingerprint) {
        setNpubFingerprint(null);
        setFingerprintStatus("No fingerprint");
        return;
      }

      try {
        // Format fingerprint as XXXX-XXXX-XXXX-XXXX
        const raw = fingerprint.toUpperCase().slice(0, 16);
        const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
        setNpubFingerprint(formatted);
        setFingerprintStatus(null);
      } catch (err) {
        console.error("Failed to format fingerprint", err);
        setNpubFingerprint(null);
        setFingerprintStatus("Unable to format fingerprint");
      }
    }, [fingerprint]);

    const handleStartSession = () => {
      if (isBusy) return;
      if (!hasKeys) return;
      session.startTakeoverGrace();
      session.setSessionStatus("active");
      startSession();
    };

    const handleEnterView = () => {
      if (isBusy) return;
      session.setSessionStatus("idle");
      session.clearSessionNotice();
    };

    const handleRefresh = () => {
      if (isBusy) return;
      if (!hasKeys) return;
      performInitialLoad();
    };

    const handleManualSave = () => {
      if (isBusy) return;
      if (!hasKeys) return;
      void performSave(history).catch((err) => {
        console.error("Failed to save history:", err);
      });
    };

    useImperativeHandle(ref, () => ({
      startSession: handleStartSession,
      enterViewMode: handleEnterView,
      refreshSession: handleRefresh,
      syncNow: handleManualSave,
    }));

    return (
      <View style={styles.card}>
        <Text style={styles.title}>Details</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>npub Fingerprint</Text>
          <Text style={styles.meta}>
            {npubFingerprint ?? fingerprintStatus ?? "Computing..."}
          </Text>
        </View>

        <View style={styles.row}>
          <Pressable
            style={[styles.button, (isBusy || !hasKeys) && styles.buttonDisabled]}
            onPress={handleStartSession}
            disabled={isBusy || !hasKeys}
          >
            <Text style={styles.buttonText}>
              {session.sessionStatus === "active" ? "Publish Mode" : "Enter Publish Mode"}
            </Text>
          </Pressable>

          <Pressable
            style={[styles.button, isBusy && styles.buttonDisabled]}
            onPress={handleEnterView}
            disabled={isBusy}
          >
            <Text style={styles.buttonText}>View Mode</Text>
          </Pressable>

          {session.sessionStatus === "active" ? (
            <Pressable
              style={[styles.button, (isBusy || !hasKeys) && styles.buttonDisabled]}
              onPress={handleManualSave}
              disabled={isBusy || !hasKeys}
            >
              <Text style={styles.buttonText}>Sync Now</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Nostr Sync</Text>
          <Text style={styles.meta}>Relays: {RELAYS.length}</Text>
          <Text style={styles.meta}>Session: {session.sessionStatus}</Text>
          {!hasKeys && session.sessionStatus !== "loading" && (
            <Text style={styles.notice}>Waiting for encryption keys...</Text>
          )}
        </View>

        {session.sessionNotice ? (
          <Text style={styles.notice}>{session.sessionNotice}</Text>
        ) : null}
        {message ? <Text style={styles.message}>{message}</Text> : null}

        <Text style={styles.meta}>Status: {status}</Text>
      </View>
    );
  }
);

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
  section: {
    marginTop: 10,
  },
  sectionTitle: {
    color: "#E5E7EB",
    fontSize: 14,
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
