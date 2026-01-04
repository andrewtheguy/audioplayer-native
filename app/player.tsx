import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import { AudioPlayer, type AudioPlayerHandle } from "@/components/AudioPlayer";
import type { SessionStatus } from "@/hooks/useNostrSession";
import { clearSessionSecret, getSavedSessionSecret } from "@/lib/history";
import TrackPlayer from "react-native-track-player";

export default function PlayerScreen() {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const playerRef = useRef<AudioPlayerHandle | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("unknown");

  useEffect(() => {
    let mounted = true;
    (async () => {
      let stored: string | null = null;
      try {
        stored = await getSavedSessionSecret();
      } catch (error) {
        console.error("Failed to load session secret.", error);
      } finally {
        if (!mounted) return;
        setSecret(stored || null);
        setLoading(false);
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
        if (typeof TrackPlayer.destroy === "function") {
          await TrackPlayer.destroy();
        }
      } catch {
        // Ignore teardown failures on logout
      }

      await clearSessionSecret();
      router.replace("/login");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to clear session secret.", error);
      setLogoutError(message || "Failed to clear session secret.");
    }
  };



  const handleSessionAction = () => {
    if (!playerRef.current) return;
    if (sessionStatus === "stale") {
      playerRef.current.takeOverSession();
      return;
    }
    if (sessionStatus === "active") {
      playerRef.current.syncNow();
      return;
    }
    playerRef.current.startSession();
  };

  const sessionCtaLabel = sessionStatus === "stale" ? "Take Over" : "Start Session";
  const showHeaderSession = sessionStatus !== "active";

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#60A5FA" />
      </View>
    );
  }

  if (!secret) {
    return <Redirect href="/login" />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>audioplayer</Text>
        <View style={styles.headerActions}>
          {showHeaderSession ? (
            <Pressable style={styles.sessionButton} onPress={handleSessionAction}>
              <Text style={styles.sessionText}>{sessionCtaLabel}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.logout} onPress={() => void handleLogout()}>
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </View>
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
          ref={playerRef}
          secret={secret}
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
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
  sessionButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#2563EB",
  },
  sessionText: {
    color: "#F9FAFB",
    fontWeight: "600",
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
