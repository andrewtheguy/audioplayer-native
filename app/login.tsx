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

type LoginState = "form" | "loading" | "error";

export default function LoginScreen() {
  const router = useRouter();
  const [state, setState] = useState<LoginState>("form");
  const [npub, setNpub] = useState("");
  const [secret, setSecret] = useState("");
  const [npubError, setNpubError] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);

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

  const validateNpub = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null; // Empty is not an error until submit
    if (!trimmed.startsWith("npub1")) {
      return "Must start with 'npub1'";
    }
    if (!parseNpub(trimmed)) {
      return "Invalid npub format";
    }
    return null;
  };

  const validateSecret = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null; // Empty is not an error until submit
    if (!isValidSecondarySecret(trimmed)) {
      return "Must be 16 characters and a valid secret format";
    }
    return null;
  };

  const handleNpubChange = (value: string) => {
    setNpub(value);
    setNpubError(validateNpub(value));
    setGeneralError(null);
  };

  const handleSecretChange = (value: string) => {
    setSecret(value);
    setSecretError(validateSecret(value));
    setGeneralError(null);
  };

  const handleNpubBlur = () => {
    const trimmed = npub.trim();
    if (trimmed !== npub) setNpub(trimmed);
    if (trimmed) {
      setNpubError(validateNpub(trimmed));
    }
  };

  const handleSecretBlur = () => {
    const trimmed = secret.trim();
    if (trimmed !== secret) setSecret(trimmed);
    if (trimmed) {
      setSecretError(validateSecret(trimmed));
    }
  };

  const handleSubmit = async () => {
    const trimmedNpub = npub.trim();
    const trimmedSecret = secret.trim();

    // Validate both fields
    let hasError = false;

    if (!trimmedNpub) {
      setNpubError("Required");
      hasError = true;
    } else {
      const npubValidation = validateNpub(trimmedNpub);
      if (npubValidation) {
        setNpubError(npubValidation);
        hasError = true;
      }
    }

    if (!trimmedSecret) {
      setSecretError("Required");
      hasError = true;
    } else {
      const secretValidation = validateSecret(trimmedSecret);
      if (secretValidation) {
        setSecretError(secretValidation);
        hasError = true;
      }
    }

    if (hasError) return;

    const pubkeyHex = parseNpub(trimmedNpub);
    if (!pubkeyHex) {
      setNpubError("Invalid npub format");
      return;
    }

    setState("loading");
    setGeneralError(null);

    try {
      // Save npub first
      await saveNpub(trimmedNpub);

      // Try to load player ID from relay
      const playerId = await loadPlayerIdFromNostr(pubkeyHex, trimmedSecret);

      if (!playerId) {
        setState("error");
        setGeneralError("No player ID found. Please set up your identity on the web app first.");
        return;
      }

      if (!isValidPlayerId(playerId)) {
        setState("error");
        setGeneralError("Invalid player ID format. The data may be corrupted.");
        return;
      }

      // Verify we can derive keys
      await deriveEncryptionKey(playerId);

      // Save the secret and navigate to player
      await setSecondarySecret(trimmedSecret);
      router.replace("/player");
    } catch (err) {
      if (err instanceof PlayerIdDecryptionError) {
        setState("form");
        setSecretError("Wrong secret - decryption failed");
        return;
      }
      setState("error");
      setGeneralError(
        `Network error: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  };

  const handleRetry = () => {
    setState("form");
    setGeneralError(null);
  };

  if (state === "loading") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#60A5FA" />
        <Text style={styles.loadingText}>Connecting to relay...</Text>
      </View>
    );
  }

  if (state === "error") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Error</Text>
        <Text style={styles.error}>{generalError}</Text>
        <Pressable style={styles.primaryButton} onPress={handleRetry}>
          <Text style={styles.primaryButtonText}>Try Again</Text>
        </Pressable>
      </View>
    );
  }

  const canSubmit = npub.trim() && secret.trim() && !npubError && !secretError;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign In</Text>
      <Text style={styles.subtitle}>
        Enter your Nostr credentials to sync your playback history.
      </Text>

      <Text style={styles.label}>npub</Text>
      <TextInput
        style={[styles.input, npubError && styles.inputError]}
        value={npub}
        onChangeText={handleNpubChange}
        onBlur={handleNpubBlur}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder="npub1..."
        placeholderTextColor="#6B7280"
        multiline
        numberOfLines={2}
      />
      {npubError ? (
        <Text style={styles.fieldError}>{npubError}</Text>
      ) : (
        <Text style={styles.fieldHint}>Your Nostr public key from the web app</Text>
      )}

      <Text style={styles.label}>Secondary Secret</Text>
      <TextInput
        style={[styles.input, secretError && styles.inputError]}
        value={secret}
        onChangeText={handleSecretChange}
        onBlur={handleSecretBlur}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder="16-character secret"
        placeholderTextColor="#6B7280"
        secureTextEntry
      />
      {secretError ? (
        <Text style={styles.fieldError}>{secretError}</Text>
      ) : (
        <Text style={styles.fieldHint}>From the web app settings page</Text>
      )}

      {generalError ? <Text style={styles.error}>{generalError}</Text> : null}

      <Pressable
        style={[styles.primaryButton, !canSubmit && styles.buttonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={!canSubmit}
      >
        <Text style={styles.primaryButtonText}>Sign In</Text>
      </Pressable>

      <Text style={styles.note}>
        Create your identity on the web app first if you do not have one.
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
    marginBottom: 24,
    lineHeight: 22,
  },
  label: {
    color: "#E5E7EB",
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#111827",
    borderRadius: 10,
    padding: 12,
    color: "#F9FAFB",
    fontFamily: "monospace",
    borderWidth: 1,
    borderColor: "#374151",
  },
  inputError: {
    borderColor: "#EF4444",
  },
  fieldError: {
    color: "#FCA5A5",
    fontSize: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  fieldHint: {
    color: "#6B7280",
    fontSize: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  primaryButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 24,
  },
  primaryButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
    fontSize: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  error: {
    color: "#FCA5A5",
    marginTop: 12,
  },
  note: {
    color: "#6B7280",
    marginTop: 20,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  loadingText: {
    color: "#9CA3AF",
    marginTop: 16,
    textAlign: "center",
  },
});
