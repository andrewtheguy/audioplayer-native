import { AudioPlayer } from "@/components/AudioPlayer";
import type { SessionStatus } from "@/hooks/useNostrSession";
import {
  clearAllIdentityData,
  getSavedNpub,
  getSecondarySecret,
  getStorageScope,
} from "@/lib/identity";
import { parseNpub } from "@/lib/nostr-crypto";
import * as TrackPlayer from "@/services/HlsTrackPlayer";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

function StatusBadge({ status }: { status: SessionStatus }) {
  const config = {
    active: { label: "ACTIVE", bg: "#22C55E20", color: "#22C55E" },
    stale: { label: "STALE", bg: "#F59E0B20", color: "#F59E0B" },
    idle: { label: "READY", bg: "#3B82F620", color: "#3B82F6" },
    loading: { label: "LOADING", bg: "#6B728020", color: "#9CA3AF" },
    needs_secret: { label: "LOCKED", bg: "#F59E0B20", color: "#F59E0B" },
    needs_setup: { label: "SETUP", bg: "#A855F720", color: "#A855F7" },
    invalid: { label: "ERROR", bg: "#EF444420", color: "#EF4444" },
    no_npub: { label: "", bg: "transparent", color: "transparent" },
  }[status];

  if (!config) return null;
  if (!config.label) return null;

  return (
    <View style={[styles.statusBadge, { backgroundColor: config.bg }]}>
      <Text style={[styles.statusBadgeText, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

interface IdentityData {
  npub: string;
  pubkeyHex: string;
  fingerprint: string;
  secondarySecret: string;
}

export default function PlayerScreen() {
  const router = useRouter();
  const [identity, setIdentity] = useState<IdentityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const npub = await getSavedNpub();
        if (!npub) {
          if (mounted) {
            setIdentity(null);
            setLoading(false);
          }
          return;
        }

        const pubkeyHex = parseNpub(npub);
        if (!pubkeyHex) {
          if (mounted) {
            setIdentity(null);
            setLoading(false);
          }
          return;
        }

        const fingerprint = getStorageScope(pubkeyHex);
        const secondarySecret = await getSecondarySecret(fingerprint);

        if (!secondarySecret) {
          if (mounted) {
            setIdentity(null);
            setLoading(false);
          }
          return;
        }

        if (mounted) {
          setIdentity({ npub, pubkeyHex, fingerprint, secondarySecret });
          setLoading(false);
        }
      } catch (error) {
        console.error("Failed to load identity.", error);
        if (mounted) {
          setIdentity(null);
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleLogout = async () => {
    setLogoutError(null);
    try {
      // Stop any ongoing playback when logging out
      try {
        await TrackPlayer.stop();
        await TrackPlayer.reset();
      } catch {
        // Ignore teardown failures on logout
      }

      if (!identity?.fingerprint) {
        throw new Error("No fingerprint to clear");
      }
      await clearAllIdentityData(identity.fingerprint);
      router.replace("/login");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to clear identity data.", error);
      setLogoutError(message || "Failed to clear identity data.");
    }
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#60A5FA" />
      </View>
    );
  }

  if (!identity) {
    return <Redirect href="/login" />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>audioplayer</Text>
          <StatusBadge status={sessionStatus} />
        </View>
        <Pressable style={styles.logout} onPress={() => void handleLogout()}>
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {logoutError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{logoutError}</Text>
            <View style={styles.errorActions}>
              <Pressable style={styles.errorButton} onPress={() => void handleLogout()}>
                <Text style={styles.errorButtonText}>Try again</Text>
              </Pressable>
              <Pressable style={styles.errorButtonAlt} onPress={() => router.replace("/login")}>
                <Text style={styles.errorButtonAltText}>Continue anyway</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <AudioPlayer
          fingerprint={identity.fingerprint}
          onSessionStatusChange={setSessionStatus}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B1120",
  },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0B1120",
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  content: {
    paddingBottom: 24,
  },
  errorBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#1F2937",
  },
  errorText: {
    color: "#FCA5A5",
    marginBottom: 8,
  },
  errorActions: {
    flexDirection: "row",
    gap: 8,
  },
  errorButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#2563EB",
  },
  errorButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
  },
  errorButtonAlt: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#0B1120",
    borderWidth: 1,
    borderColor: "#374151",
  },
  errorButtonAltText: {
    color: "#E5E7EB",
    fontWeight: "600",
  },
  headerTitle: {
    color: "#F9FAFB",
    fontSize: 18,
    fontWeight: "700",
  },
  logout: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#1F2937",
  },
  logoutText: {
    color: "#E5E7EB",
  },
});
