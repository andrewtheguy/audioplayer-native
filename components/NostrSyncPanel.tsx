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
  syncNow: () => void;
}

interface NostrSyncPanelProps {
  encryptionKeys: NostrKeys | null;
  fingerprint: string;
  history: HistoryEntry[];
  session: NostrSessionApi;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const statusConfig: Record<string, { label: string; bg: string; color: string }> = {
    active: { label: "ACTIVE", bg: "#22C55E20", color: "#22C55E" },
    stale: { label: "STALE", bg: "#F59E0B20", color: "#F59E0B" },
    idle: { label: "READY", bg: "#3B82F620", color: "#3B82F6" },
    loading: { label: "LOADING", bg: "#6B728020", color: "#9CA3AF" },
    needs_secret: { label: "LOCKED", bg: "#F59E0B20", color: "#F59E0B" },
    needs_setup: { label: "SETUP", bg: "#A855F720", color: "#A855F7" },
    invalid: { label: "ERROR", bg: "#EF444420", color: "#EF4444" },
    no_npub: { label: "", bg: "transparent", color: "transparent" },
  };

  const config = statusConfig[status];
  if (!config || !config.label) return null;

  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.badgeText, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

export const NostrSyncPanel = forwardRef<NostrSyncPanelHandle, NostrSyncPanelProps>(
  ({ encryptionKeys, fingerprint, history, session, onHistoryLoaded, onRemoteSync }, ref) => {
    const [npubFingerprint, setNpubFingerprint] = useState<string | null>(null);
    const [showDetails, setShowDetails] = useState(false);

    const hasKeys = encryptionKeys !== null;

    const {
      status,
      message,
      performInitialLoad,
      performLoad,
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
        return;
      }

      try {
        // Format fingerprint as XXXX-XXXX-XXXX-XXXX
        const raw = fingerprint.toUpperCase().slice(0, 16);
        const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
        setNpubFingerprint(formatted);
      } catch (err) {
        console.error("Failed to format fingerprint", err);
        setNpubFingerprint(null);
      }
    }, [fingerprint]);

    const handleStartSession = () => {
      if (isBusy) return;
      if (!hasKeys) return;
      session.startTakeoverGrace();
      startSession();
    };

    const handleTakeOver = () => {
      if (isBusy) return;
      if (!hasKeys) return;
      session.startTakeoverGrace();
      performLoad(true); // true = isTakeOver, sets status to active on success
    };

    const handleSyncNow = () => {
      if (isBusy) return;
      if (!hasKeys) return;
      void performSave(history).catch((err) => {
        console.error("Failed to save history:", err);
      });
    };

    useImperativeHandle(ref, () => ({
      syncNow: handleSyncNow,
    }));

    // Render action button based on session status
    const renderActionButton = () => {
      switch (session.sessionStatus) {
        case "idle":
          return (
            <Pressable
              style={[styles.button, styles.buttonPrimary, (isBusy || !hasKeys) && styles.buttonDisabled]}
              onPress={handleStartSession}
              disabled={isBusy || !hasKeys}
            >
              <Text style={styles.buttonText}>Start Session</Text>
            </Pressable>
          );

        case "active":
          return (
            <View style={styles.activeContainer}>
              <Pressable
                style={[styles.button, styles.buttonPrimary, (isBusy || !hasKeys) && styles.buttonDisabled]}
                onPress={handleSyncNow}
                disabled={isBusy || !hasKeys}
              >
                <Text style={styles.buttonText}>{isBusy ? "Syncing..." : "Sync Now"}</Text>
              </Pressable>
              <Text style={styles.autoSaveText}>Auto-save enabled</Text>
            </View>
          );

        case "stale":
          return (
            <Pressable
              style={[styles.button, styles.buttonWarning, (isBusy || !hasKeys) && styles.buttonDisabled]}
              onPress={handleTakeOver}
              disabled={isBusy || !hasKeys}
            >
              <Text style={styles.buttonText}>Take Over Session</Text>
            </Pressable>
          );

        case "loading":
          return (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>Loading...</Text>
            </View>
          );

        default:
          return null;
      }
    };

    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Nostr Sync</Text>
          <StatusBadge status={session.sessionStatus} />
        </View>

        {renderActionButton()}

        {session.sessionNotice ? (
          <View style={[
            styles.noticeContainer,
            session.sessionStatus === "stale" && styles.noticeWarning,
          ]}>
            <Text style={[
              styles.notice,
              session.sessionStatus === "stale" && styles.noticeTextWarning,
            ]}>
              {session.sessionNotice}
            </Text>
          </View>
        ) : null}

        {message && status !== "idle" ? (
          <Text style={[
            styles.message,
            status === "error" && styles.messageError,
          ]}>
            {message}
          </Text>
        ) : null}

        {/* Collapsible details */}
        <Pressable
          style={styles.detailsToggle}
          onPress={() => setShowDetails(!showDetails)}
        >
          <Text style={styles.detailsToggleText}>
            {showDetails ? "▼" : "▶"} Details
          </Text>
        </Pressable>

        {showDetails && (
          <View style={styles.detailsContainer}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Fingerprint</Text>
              <Text style={styles.detailValue}>{npubFingerprint ?? "..."}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Relays</Text>
              <Text style={styles.detailValue}>{RELAYS.length} connected</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Session ID</Text>
              <Text style={styles.detailValueMono} numberOfLines={1}>
                {session.localSessionId.slice(0, 12)}...
              </Text>
            </View>
            <View style={styles.relayList}>
              {RELAYS.map((relay) => (
                <Text key={relay} style={styles.relayItem}>{relay}</Text>
              ))}
            </View>
          </View>
        )}
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
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    color: "#F9FAFB",
    fontSize: 16,
    fontWeight: "600",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonPrimary: {
    backgroundColor: "#2563EB",
  },
  buttonWarning: {
    backgroundColor: "#D97706",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#F9FAFB",
    fontWeight: "600",
    fontSize: 14,
  },
  activeContainer: {
    gap: 6,
  },
  autoSaveText: {
    color: "#6B7280",
    fontSize: 12,
    textAlign: "center",
  },
  loadingContainer: {
    paddingVertical: 10,
    alignItems: "center",
  },
  loadingText: {
    color: "#9CA3AF",
    fontSize: 14,
  },
  noticeContainer: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#1F2937",
  },
  noticeWarning: {
    backgroundColor: "#78350F",
  },
  notice: {
    color: "#FCA5A5",
    fontSize: 13,
  },
  noticeTextWarning: {
    color: "#FCD34D",
  },
  message: {
    color: "#93C5FD",
    marginTop: 10,
    fontSize: 13,
  },
  messageError: {
    color: "#FCA5A5",
  },
  detailsToggle: {
    marginTop: 16,
    paddingVertical: 4,
  },
  detailsToggleText: {
    color: "#6B7280",
    fontSize: 13,
  },
  detailsContainer: {
    marginTop: 8,
    paddingLeft: 12,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  detailLabel: {
    color: "#6B7280",
    fontSize: 12,
  },
  detailValue: {
    color: "#9CA3AF",
    fontSize: 12,
  },
  detailValueMono: {
    color: "#9CA3AF",
    fontSize: 11,
    fontFamily: "monospace",
    flex: 1,
    textAlign: "right",
  },
  relayList: {
    marginTop: 8,
  },
  relayItem: {
    color: "#6B7280",
    fontSize: 10,
    fontFamily: "monospace",
    paddingVertical: 2,
  },
});

NostrSyncPanel.displayName = "NostrSyncPanel";
