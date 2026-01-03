import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { getSavedSessionSecret } from "@/lib/history";

export default function Index() {
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

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0B1120" }}>
        <ActivityIndicator color="#60A5FA" />
      </View>
    );
  }

  if (secret) {
    return <Redirect href="/player" />;
  }

  return <Redirect href="/login" />;
}
