import { getSavedNpub, getSecondarySecret, getStorageScope } from "@/lib/identity";
import { parseNpub } from "@/lib/nostr-crypto";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

export default function Index() {
  const [hasIdentity, setHasIdentity] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const npub = await getSavedNpub();
        if (!npub) {
          if (mounted) {
            setHasIdentity(false);
            setLoading(false);
          }
          return;
        }

        const pubkeyHex = parseNpub(npub);
        if (!pubkeyHex) {
          if (mounted) {
            setHasIdentity(false);
            setLoading(false);
          }
          return;
        }

        const fingerprint = getStorageScope(pubkeyHex);
        const secondarySecret = await getSecondarySecret(fingerprint);

        if (mounted) {
          setHasIdentity(Boolean(secondarySecret));
          setLoading(false);
        }
      } catch (err) {
        console.error("Failed to check identity:", err);
        if (mounted) {
          setHasIdentity(false);
          setLoading(false);
        }
      }
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

  if (hasIdentity) {
    return <Redirect href="/player" />;
  }

  return <Redirect href="/login" />;
}
