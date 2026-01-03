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

export default function PlayerScreen() {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const playerRef = useRef<AudioPlayerHandle | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("unknown");

  useEffect(() => {
    let mounted = true;
    (async () => {
      const stored = await getSavedSessionSecret();
      if (!mounted) return;
      setSecret(stored || null);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleLogout = async () => {
    await clearSessionSecret();
    router.replace("/login");
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
