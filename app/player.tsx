import { useEffect, useState } from "react";
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
import { AudioPlayer } from "@/components/AudioPlayer";
import { clearSessionSecret, getSavedSessionSecret } from "@/lib/history";

export default function PlayerScreen() {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        <Pressable style={styles.logout} onPress={() => void handleLogout()}>
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <AudioPlayer secret={secret} />
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
  content: {
    paddingBottom: 24,
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
