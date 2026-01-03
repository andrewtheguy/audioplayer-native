import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { generateSecret, isValidSecret } from "@/lib/nostr-crypto";
import { saveSessionSecret } from "@/lib/history";

export default function LoginScreen() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleUseSecret = async () => {
    if (!secret) {
      setError("Enter a secret first.");
      return;
    }
    if (!isValidSecret(secret)) {
      setError("Invalid secret. Check for typos.");
      return;
    }
    try {
      await saveSessionSecret(secret);
      router.replace("/player");
    } catch (err) {
      console.error("Failed to save session secret.", err);
      setError("Unable to save the secret. Please try again.");
    }
  };

  const handleGenerate = () => {
    try {
      const next = generateSecret();
      setSecret(next);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to generate secret.", err);
      setSecret("");
      setError(message || "Unable to generate a new secret.");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter Secret</Text>
      <Text style={styles.subtitle}>Paste the 16-character secret to sync history.</Text>

      <TextInput
        style={styles.input}
        value={secret}
        onChangeText={(value) => {
          setSecret(value.trim());
          if (error) setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="e.g. OR8QqY-v_4XA64vx"
        placeholderTextColor="#6B7280"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.primaryButton} onPress={() => void handleUseSecret()}>
        <Text style={styles.primaryButtonText}>Continue</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={handleGenerate}>
        <Text style={styles.secondaryButtonText}>Generate New Secret</Text>
      </Pressable>

      <Text style={styles.note}>Keep this secret safe. Anyone with it can access the sync history.</Text>
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
  },
  input: {
    backgroundColor: "#111827",
    borderRadius: 10,
    padding: 12,
    color: "#F9FAFB",
    marginBottom: 12,
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
  error: {
    color: "#FCA5A5",
    marginBottom: 8,
  },
  note: {
    color: "#6B7280",
    marginTop: 12,
    fontSize: 12,
  },
});
