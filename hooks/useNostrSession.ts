import {
  clearAllIdentityData,
  clearSecondarySecret,
  getSavedNpub,
  getSecondarySecret,
  getStorageScope,
  saveNpub,
  setSecondarySecret,
} from "@/lib/identity";
import {
  deriveEncryptionKey,
  generateSessionId,
  isValidPlayerId,
  isValidSecondarySecret,
  parseNpub,
  type NostrKeys,
} from "@/lib/nostr-crypto";
import {
  loadPlayerIdFromNostr,
  PlayerIdDecryptionError,
} from "@/lib/nostr-sync";
import { useCallback, useEffect, useRef, useState } from "react";

export type SessionStatus =
  | "no_npub" // No npub stored
  | "needs_secret" // Has npub, needs secondary secret entry
  | "loading" // Fetching player id from relay
  | "needs_setup" // No player id exists, needs setup on web
  | "idle" // Ready, has player id, not started
  | "active" // Active session on this device
  | "stale" // Another device took over
  | "invalid"; // Invalid npub format

interface UseNostrSessionOptions {
  onSessionStatusChange?: (status: SessionStatus) => void;
  takeoverGraceMs?: number;
}

interface UseNostrSessionResult {
  // Identity
  npub: string | null;
  pubkeyHex: string | null;
  fingerprint: string | null;

  // Player ID and encryption keys
  playerId: string | null;
  encryptionKeys: NostrKeys | null;

  // Secondary secret
  secondarySecret: string | null;

  // Session state
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  ignoreRemoteUntil: number;

  // State setters
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;

  // Login actions
  submitNpub: (npub: string) => Promise<boolean>;
  submitSecondarySecret: (secret: string) => Promise<boolean>;
  clearIdentity: () => Promise<void>;
}

const DEFAULT_TAKEOVER_GRACE_MS = 15000;

export function useNostrSession({
  onSessionStatusChange,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
}: UseNostrSessionOptions = {}): UseNostrSessionResult {
  // Identity state
  const [npub, setNpub] = useState<string | null>(null);
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // Player ID and encryption keys (combined for atomic updates)
  const [playerState, setPlayerState] = useState<{
    playerId: string | null;
    encryptionKeys: NostrKeys | null;
  }>({ playerId: null, encryptionKeys: null });
  const { playerId, encryptionKeys } = playerState;

  // Secondary secret
  const [secondarySecret, setSecondarySecretState] = useState<string | null>(null);

  // Session state
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("no_npub");
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [localSessionId] = useState(() => generateSessionId());
  const [ignoreRemoteUntil, setIgnoreRemoteUntil] = useState<number>(0);

  const prevStatusRef = useRef<SessionStatus>(sessionStatus);
  const staleNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSessionStatusChangeRef = useRef(onSessionStatusChange);
  const initializingRef = useRef(false);

  useEffect(() => {
    onSessionStatusChangeRef.current = onSessionStatusChange;
  }, [onSessionStatusChange]);

  useEffect(() => {
    onSessionStatusChangeRef.current?.(sessionStatus);
  }, [sessionStatus]);

  // Show stale notice when session becomes stale
  useEffect(() => {
    if (prevStatusRef.current !== "stale" && sessionStatus === "stale") {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
      }
      staleNoticeTimerRef.current = setTimeout(() => {
        setSessionNotice("Another device is now active.");
        staleNoticeTimerRef.current = null;
      }, 0);
    }
    prevStatusRef.current = sessionStatus;
    return () => {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
        staleNoticeTimerRef.current = null;
      }
    };
  }, [sessionStatus]);

  // Initialize session on mount
  const initializeSession = useCallback(async () => {
    if (initializingRef.current) return;
    initializingRef.current = true;

    // Reset player state at start of initialization (atomic)
    setPlayerState({ playerId: null, encryptionKeys: null });

    try {
      // 1. Check if npub is saved
      const savedNpub = await getSavedNpub();
      if (!savedNpub) {
        setNpub(null);
        setPubkeyHex(null);
        setFingerprint(null);
        setSecondarySecretState(null);
        setSessionStatus("no_npub");
        return;
      }

      // 2. Validate and decode npub
      const hex = parseNpub(savedNpub);
      if (!hex) {
        setNpub(savedNpub);
        setPubkeyHex(null);
        setSessionStatus("invalid");
        setSessionNotice("Invalid npub format.");
        return;
      }

      setNpub(savedNpub);
      setPubkeyHex(hex);

      // 3. Get fingerprint for storage scoping
      const fp = getStorageScope(hex);
      setFingerprint(fp);

      // 4. Check for cached secondary secret
      const cachedSecret = await getSecondarySecret(fp);
      if (!cachedSecret) {
        setSessionStatus("needs_secret");
        return;
      }

      setSecondarySecretState(cachedSecret);

      // 5. Try to load player id from relay
      setSessionStatus("loading");
      try {
        const remotePlayerId = await loadPlayerIdFromNostr(hex, cachedSecret);
        if (remotePlayerId && isValidPlayerId(remotePlayerId)) {
          const keys = await deriveEncryptionKey(remotePlayerId);
          setPlayerState({ playerId: remotePlayerId, encryptionKeys: keys });
          setSessionStatus("idle");
          return;
        }
        // No player id event exists - needs setup on web
        setSessionStatus("needs_setup");
        setSessionNotice("No player ID found. Please set up your identity on the web app first.");
        return;
      } catch (err) {
        if (err instanceof PlayerIdDecryptionError) {
          // Decryption failed - wrong secondary secret
          console.warn("Failed to decrypt player id:", err.message);
          setSessionStatus("needs_secret");
          setSessionNotice("Wrong secondary secret. Please re-enter.");
          // Clear the invalid secret from both React state and storage
          setSecondarySecretState(null);
          await clearSecondarySecret(fp);
          return;
        }
        // Network or other error - preserve the secret and show error
        console.warn("Failed to load player id from relay:", err);
        setSessionStatus("needs_secret");
        setSessionNotice(
          `Network error: ${err instanceof Error ? err.message : "Failed to connect to relay"}. Please try again.`
        );
        return;
      }
    } finally {
      initializingRef.current = false;
    }
  }, []);

  // Run initialization on mount
  useEffect(() => {
    initializeSession();
  }, [initializeSession]);

  // Submit npub (first step of login)
  const submitNpub = useCallback(
    async (npubInput: string): Promise<boolean> => {
      const trimmed = npubInput.trim();
      const hex = parseNpub(trimmed);
      if (!hex) {
        setSessionNotice("Invalid npub format.");
        return false;
      }

      // Save npub
      await saveNpub(trimmed);
      setNpub(trimmed);
      setPubkeyHex(hex);

      // Compute fingerprint
      const fp = getStorageScope(hex);
      setFingerprint(fp);

      // Check if we have a cached secret for this npub
      const cachedSecret = await getSecondarySecret(fp);
      if (cachedSecret) {
        setSecondarySecretState(cachedSecret);
        // Try to load player id
        setSessionStatus("loading");
        try {
          const remotePlayerId = await loadPlayerIdFromNostr(hex, cachedSecret);
          if (remotePlayerId && isValidPlayerId(remotePlayerId)) {
            const keys = await deriveEncryptionKey(remotePlayerId);
            setPlayerState({ playerId: remotePlayerId, encryptionKeys: keys });
            setSessionStatus("idle");
            setSessionNotice(null);
            return true;
          }
          setSessionStatus("needs_setup");
          setSessionNotice("No player ID found. Please set up your identity on the web app first.");
          return true;
        } catch (err) {
          if (err instanceof PlayerIdDecryptionError) {
            setSecondarySecretState(null);
            await clearSecondarySecret(fp);
            setSessionStatus("needs_secret");
            setSessionNotice("Cached secret is invalid. Please re-enter.");
            return true;
          }
          setSessionStatus("needs_secret");
          setSessionNotice(
            `Network error: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`
          );
          return true;
        }
      }

      // No cached secret, prompt for it
      setSessionStatus("needs_secret");
      setSessionNotice(null);
      return true;
    },
    []
  );

  // Submit secondary secret (second step of login)
  const submitSecondarySecret = useCallback(
    async (secret: string): Promise<boolean> => {
      const trimmed = secret.trim();
      if (!isValidSecondarySecret(trimmed)) {
        setSessionNotice("Invalid secondary secret format.");
        return false;
      }

      if (!pubkeyHex || !fingerprint) {
        setSessionNotice("No identity loaded.");
        return false;
      }

      // Set React state for UI feedback
      setSecondarySecretState(trimmed);

      // Try to load player id from relay with new secret
      setSessionStatus("loading");
      try {
        const remotePlayerId = await loadPlayerIdFromNostr(pubkeyHex, trimmed);
        if (remotePlayerId && isValidPlayerId(remotePlayerId)) {
          // Derive keys first, then set state atomically
          const keys = await deriveEncryptionKey(remotePlayerId);
          await setSecondarySecret(fingerprint, trimmed);
          setPlayerState({ playerId: remotePlayerId, encryptionKeys: keys });
          setSessionStatus("idle");
          setSessionNotice(null);
          return true;
        }
        // No player id exists - save secret but show setup needed
        await setSecondarySecret(fingerprint, trimmed);
        setSessionStatus("needs_setup");
        setSessionNotice("No player ID found. Please set up your identity on the web app first.");
        return true;
      } catch (err) {
        if (err instanceof PlayerIdDecryptionError) {
          // Decryption failed - wrong secret, clear React state
          setSecondarySecretState(null);
          setSessionNotice("Wrong secondary secret. Please try again.");
          setSessionStatus("needs_secret");
          return false;
        }
        // Network or other error - persist secret for retry
        await setSecondarySecret(fingerprint, trimmed);
        setSessionNotice(
          `Network error: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`
        );
        setSessionStatus("needs_secret");
        return false;
      }
    },
    [pubkeyHex, fingerprint]
  );

  // Clear identity (logout)
  const clearIdentity = useCallback(async (): Promise<void> => {
    if (!fingerprint) {
      throw new Error("No fingerprint to clear");
    }
    await clearAllIdentityData(fingerprint);
    setNpub(null);
    setPubkeyHex(null);
    setFingerprint(null);
    setSecondarySecretState(null);
    setPlayerState({ playerId: null, encryptionKeys: null });
    setSessionStatus("no_npub");
    setSessionNotice(null);
  }, [fingerprint]);

  const startTakeoverGrace = useCallback(() => {
    setIgnoreRemoteUntil(Date.now() + takeoverGraceMs);
  }, [takeoverGraceMs]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  return {
    npub,
    pubkeyHex,
    fingerprint,
    playerId,
    encryptionKeys,
    secondarySecret,
    sessionStatus,
    sessionNotice,
    localSessionId,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
    submitNpub,
    submitSecondarySecret,
    clearIdentity,
  };
}
