import {
  getSavedNpub,
  saveNpub,
  setSecondarySecret,
} from "@/lib/identity";
import {
  deriveEncryptionKey,
  isValidPlayerId,
  isValidSecondarySecret,
  parseNpub,
} from "@/lib/nostr-crypto";
import {
  loadPlayerIdFromNostr,
  PlayerIdDecryptionError,
} from "@/lib/nostr-sync";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type LoginStep = "npub" | "secret" | "loading" | "error";

export default function LoginScreen() {
  const router = useRouter();
  const [step, setStep] = useState<LoginStep>("npub");
  const [npub, setNpub] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);

  // Check for saved npub on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const savedNpub = await getSavedNpub();
        if (savedNpub && mounted) {
          const hex = parseNpub(savedNpub);
          if (hex) {
            setNpub(savedNpub);
            setPubkeyHex(hex);
            setStep("secret");
          }
        }
      } catch (err) {
        console.error("Failed to load saved npub:", err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSubmitNpub = async () => {
    const trimmed = npub.trim();
    if (!trimmed) {
      setError("Enter your npub first.");
      return;
    }

    const hex = parseNpub(trimmed);
    if (!hex) {
      setError("Invalid npub format. It should start with 'npub1'.");
      return;
    }

    try {
      await saveNpub(trimmed);
      setPubkeyHex(hex);
      setStep("secret");
      setError(null);
    } catch (err) {
      console.error("Failed to save npub:", err);
      setError("Failed to save npub. Please try again.");
    }
  };

  const handleSubmitSecret = async () => {
    const trimmed = secret.trim();
    if (!trimmed) {
      setError("Enter your secondary secret first.");
      return;
    }

    if (!isValidSecondarySecret(trimmed)) {
      setError("Invalid secondary secret format. Check for typos.");
      return;
    }

    if (!pubkeyHex) {
      setError("Missing npub. Please go back and enter it.");
      return;
    }

    setStep("loading");
    setError(null);

    try {
      // Try to load player ID from relay
      const playerId = await loadPlayerIdFromNostr(pubkeyHex, trimmed);

      if (!playerId) {
        setStep("error");
        setError("No player ID found. Please set up your identity on the web app first.");
        return;
      }

      if (!isValidPlayerId(playerId)) {
        setStep("error");
        setError("Invalid player ID format. The data may be corrupted.");
        return;
      }

      // Verify we can derive keys
      await deriveEncryptionKey(playerId);

      // Save the secret and navigate to player
      await setSecondarySecret(trimmed);
      router.replace("/player");
    } catch (err) {
      if (err instanceof PlayerIdDecryptionError) {
        setStep("secret");
        setError("Wrong secondary secret. Please check and try again.");
        return;
      }
      setStep("error");
      setError(
        `Network error: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`
      );
    }
  };

  const handleBack = () => {
    setStep("npub");
    setSecret("");
    setError(null);
    setPubkeyHex(null);
  };

  const handleRetry = () => {
    setStep("secret");
    setError(null);
  };

  if (step === "loading") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#60A5FA" />
        <Text style={styles.loadingText}>Loading player ID from relay...</Text>
      </View>
    );
  }

  if (step === "error") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Error</Text>
        <Text style={styles.error}>{error}</Text>
        <View style={styles.buttonRow}>
          <Pressable style={styles.secondaryButton} onPress={handleBack}>
            <Text style={styles.secondaryButtonText}>Change npub</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={handleRetry}>
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (step === "secret") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Enter Secondary Secret</Text>
        <Text style={styles.subtitle}>
          Enter the 16-character secondary secret from your web app to decrypt your player ID.
        </Text>

        <View style={styles.npubBadge}>
          <Text style={styles.npubBadgeLabel}>npub:</Text>
          <Text style={styles.npubBadgeValue} numberOfLines={1} ellipsizeMode="middle">
            {npub}
          </Text>
        </View>

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, secret ? styles.inputWithButton : null]}
            value={secret}
            onChangeText={(value) => {
              setSecret(value);
              if (error) setError(null);
            }}
            onBlur={() => {
              const trimmed = secret.trim();
              if (trimmed !== secret) setSecret(trimmed);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            placeholder="e.g. OR8QqY-v_4XA64vx"
            placeholderTextColor="#6B7280"
          />
          {secret ? (
            <Pressable
              style={styles.clearButton}
              onPress={() => {
                setSecret("");
                setError(null);
              }}
              accessibilityLabel="Clear secret input"
            >
              <Text style={styles.clearButtonText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable style={styles.primaryButton} onPress={() => void handleSubmitSecret()}>
          <Text style={styles.primaryButtonText}>Continue</Text>
        </Pressable>

        <Pressable style={styles.secondaryButton} onPress={handleBack}>
          <Text style={styles.secondaryButtonText}>Use Different npub</Text>
        </Pressable>

        <Text style={styles.note}>
          Get your secondary secret from the web app's settings page.
        </Text>
      </View>
    );
  }

  // step === "npub"
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter npub</Text>
      <Text style={styles.subtitle}>
        Enter your Nostr public key (npub) to sync your playback history.
      </Text>

      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, npub ? styles.inputWithButton : null]}
          value={npub}
          onChangeText={(value) => {
            setNpub(value);
            if (error) setError(null);
          }}
          onBlur={() => {
            const trimmed = npub.trim();
            if (trimmed !== npub) setNpub(trimmed);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          placeholder="npub1..."
          placeholderTextColor="#6B7280"
          multiline
          numberOfLines={2}
        />
        {npub ? (
          <Pressable
            style={styles.clearButton}
            onPress={() => {
              setNpub("");
              setError(null);
            }}
            accessibilityLabel="Clear npub input"
          >
            <Text style={styles.clearButtonText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.primaryButton} onPress={() => void handleSubmitNpub()}>
        <Text style={styles.primaryButtonText}>Continue</Text>
      </Pressable>

      <Text style={styles.note}>
        Get your npub from the web app. If you don't have one, create an identity on the web first.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    backgroundColor: "#0B1120",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#F9FAFB",
    marginBottom: 8,
  },
  subtitle: {
    color: "#9CA3AF",
    marginBottom: 16,
    lineHeight: 22,
  },
  npubBadge: {
    flexDirection: "row",
    backgroundColor: "#1F2937",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    alignItems: "center",
  },
  npubBadgeLabel: {
    color: "#9CA3AF",
    fontWeight: "600",
    marginRight: 8,
  },
  npubBadgeValue: {
    color: "#60A5FA",
    flex: 1,
    fontFamily: "monospace",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  input: {
    backgroundColor: "#111827",
    borderRadius: 10,
    padding: 12,
    color: "#F9FAFB",
    flex: 1,
    fontFamily: "monospace",
  },
  inputWithButton: {
    marginRight: 8,
  },
  primaryButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: "#1F2937",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 12,
  },
  secondaryButtonText: {
    color: "#E5E7EB",
    fontWeight: "600",
  },
  clearButton: {
    backgroundColor: "#1F2937",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  clearButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
  },
  error: {
    color: "#FCA5A5",
    marginBottom: 8,
  },
  note: {
    color: "#6B7280",
    marginTop: 16,
    fontSize: 12,
    lineHeight: 18,
  },
  loadingText: {
    color: "#9CA3AF",
    marginTop: 16,
    textAlign: "center",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
});
