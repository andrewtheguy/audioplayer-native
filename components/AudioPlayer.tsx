import { NostrSyncPanel, type NostrSyncPanelHandle } from "@/components/NostrSyncPanel";
import type { SessionStatus } from "@/hooks/useNostrSession";
import { useNostrSession } from "@/hooks/useNostrSession";
import type { HistoryEntry } from "@/lib/history";
import { getHistory, saveHistory } from "@/lib/history";
import { Audio } from "expo-av";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

export interface AudioPlayerHandle {
  startSession: () => void;
  takeOverSession: () => void;
  refreshSession: () => void;
  syncNow: () => void;
  getSessionStatus: () => SessionStatus;
}

interface AudioPlayerProps {
  secret: string;
  onSessionStatusChange?: (status: SessionStatus) => void;
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  ({ secret, onSessionStatusChange }, ref) => {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [nowPlayingUrl, setNowPlayingUrl] = useState<string | null>(null);
  const [nowPlayingTitle, setNowPlayingTitle] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [isLiveStream, setIsLiveStream] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const soundRef = useRef<Audio.Sound | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const currentTitleRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const lastAutoSaveAtRef = useRef(0);
  const isLiveStreamRef = useRef(false);

  const session = useNostrSession({
    secret,
    onSessionStatusChange,
  });
  const isViewOnly = session.sessionStatus !== "active";
  const syncRef = useRef<NostrSyncPanelHandle | null>(null);
  const lastSessionStatusRef = useRef<SessionStatus>(session.sessionStatus);

  useEffect(() => {
    isLiveStreamRef.current = isLiveStream;
  }, [isLiveStream]);

  useEffect(() => {
    onSessionStatusChange?.(session.sessionStatus);
  }, [onSessionStatusChange, session.sessionStatus]);

  useImperativeHandle(ref, () => ({
    startSession: () => syncRef.current?.startSession(),
    takeOverSession: () => syncRef.current?.takeOverSession(),
    refreshSession: () => syncRef.current?.refreshSession(),
    syncNow: () => syncRef.current?.syncNow(),
    getSessionStatus: () => session.sessionStatus,
  }));


  useEffect(() => {
    return () => {
      if (soundRef.current) {
        void soundRef.current.unloadAsync();
      }
    };
  }, []);

  useEffect(() => {
    if (session.sessionStatus === "active") return;
    if (soundRef.current) {
      const sound = soundRef.current;
      soundRef.current = null;
      Promise.resolve()
        .then(() => sound.stopAsync())
        .catch(() => {})
        .finally(() => {
          void sound.unloadAsync().catch(() => {});
        });
    }
    setIsPlaying(false);
  }, [session.sessionStatus]);

  const persistHistory = useCallback((next: HistoryEntry[]) => {
    setHistory(next);
    void saveHistory(next);
  }, []);

  const saveHistoryEntry = useCallback(
    (position?: number, options?: { allowLive?: boolean }) => {
      if (isViewOnly) return;
      if (!currentUrlRef.current) return;
      if (isLiveStreamRef.current && !options?.allowLive) return;

      const positionToSave = Number.isFinite(position) ? (position as number) : currentTime;
      const now = new Date().toISOString();
      const entry: HistoryEntry = {
        url: currentUrlRef.current,
        title: currentTitleRef.current ?? undefined,
        lastPlayedAt: now,
        position: positionToSave,
      };

      setHistory((prev) => {
        const existingIndex = prev.findIndex((item) => item.url === entry.url);
        let next: HistoryEntry[];
        if (existingIndex >= 0) {
          next = [entry, ...prev.filter((_, i) => i !== existingIndex)];
        } else {
          next = [entry, ...prev];
        }
        void saveHistory(next);
        return next;
      });
    },
    [currentTime, isViewOnly]
  );

  const onPlaybackStatusUpdate = (status: Audio.AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) {
        setError(status.error);
      }
      return;
    }

    setIsPlaying(status.isPlaying);
    const nextTime = status.positionMillis / 1000;
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);

    if (typeof status.durationMillis === "number") {
      setDuration(status.durationMillis / 1000);
      setIsLiveStream(false);
      isLiveStreamRef.current = false;
    } else {
      setDuration(null);
      setIsLiveStream(true);
      isLiveStreamRef.current = true;
    }

    if (
      status.isPlaying &&
      !isLiveStreamRef.current &&
      Date.now() - lastAutoSaveAtRef.current >= 5000
    ) {
      lastAutoSaveAtRef.current = Date.now();
      saveHistoryEntry(nextTime);
    }
  };

  const loadUrl = useCallback(
    async (
      urlToLoad: string,
      resolvedTitle?: string,
      options?: { skipInitialSave?: boolean; startPosition?: number | null }
    ) => {
      if (!urlToLoad) return;
      setLoading(true);
      setError(null);

      try {
        if (soundRef.current) {
          await soundRef.current.unloadAsync();
          soundRef.current = null;
        }

        currentUrlRef.current = urlToLoad;
        currentTitleRef.current = resolvedTitle ?? null;
        setNowPlayingUrl(urlToLoad);
        setNowPlayingTitle(resolvedTitle ?? null);

        const { sound, status } = await Audio.Sound.createAsync(
          { uri: urlToLoad },
          { shouldPlay: false },
          onPlaybackStatusUpdate
        );

        soundRef.current = sound;

        if (status.isLoaded && typeof status.durationMillis === "number") {
          setDuration(status.durationMillis / 1000);
          setIsLiveStream(false);
          isLiveStreamRef.current = false;
        } else {
          setDuration(null);
          setIsLiveStream(true);
          isLiveStreamRef.current = true;
        }

        const startPosition = options?.startPosition ?? null;
        const shouldSeek =
          !isLiveStreamRef.current && startPosition !== null && Number.isFinite(startPosition);
        const targetPosition = shouldSeek ? Math.max(0, startPosition as number) : 0;

        if (shouldSeek) {
          try {
            await sound.setPositionAsync(targetPosition * 1000);
          } catch {
            // If the seek fails, we still fall back to letting the status update drive position.
          }
        }

        currentTimeRef.current = targetPosition;
        setCurrentTime(targetPosition);

        if (!options?.skipInitialSave) {
          saveHistoryEntry(0, { allowLive: true });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audio");
      } finally {
        setLoading(false);
      }
    },
    [saveHistoryEntry]
  );

  const applyHistoryDisplay = useCallback((entry: HistoryEntry) => {
    currentUrlRef.current = entry.url;
    currentTitleRef.current = entry.title ?? null;
    setNowPlayingUrl(entry.url);
    setNowPlayingTitle(entry.title ?? null);
    setCurrentTime(Number.isFinite(entry.position) ? entry.position : 0);
  }, []);

  const loadFromHistory = useCallback(
    (entry: HistoryEntry, options?: { allowViewOnly?: boolean }) => {
      if (!entry) return;
      if (isViewOnly && !options?.allowViewOnly) return;

      if (isViewOnly) {
        applyHistoryDisplay(entry);
        return;
      }
      const start = Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0;
      currentTimeRef.current = start;
      setCurrentTime(start);

      void loadUrl(entry.url, entry.title, {
        skipInitialSave: true,
        startPosition: start,
      });
    },
    [applyHistoryDisplay, isViewOnly, loadUrl]
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const stored = await getHistory();
      if (!mounted) return;
      setHistory(stored);
      if (stored[0]) {
        applyHistoryDisplay(stored[0]);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [applyHistoryDisplay]);

  const loadStream = () => {
    if (isViewOnly) return;
    const urlToLoad = url.trim();
    if (!urlToLoad) {
      setError("Please enter a URL");
      return;
    }

    const existing = history.find((item) => item.url === urlToLoad);
    if (existing) {
      const updated = title.trim() ? { ...existing, title: title.trim() } : existing;
      if (updated !== existing) {
        const next = [updated, ...history.filter((h) => h.url !== updated.url)];
        persistHistory(next);
      }
      loadFromHistory(updated);
      return;
    }

    void loadUrl(urlToLoad, title.trim() || undefined);
  };

  const togglePlayPause = async () => {
    if (isViewOnly) return;
    const sound = soundRef.current;
    if (!sound) return;

    try {
      if (isPlaying) {
        await sound.pauseAsync();
      } else {
        await sound.playAsync();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playback error");
    }
  };

  const seekBy = async (deltaSeconds: number) => {
    if (isViewOnly) return;
    const sound = soundRef.current;
    if (!sound || isLiveStreamRef.current) return;
    const next = Math.max(0, currentTime + deltaSeconds);
    await sound.setPositionAsync(next * 1000);
  };

  useEffect(() => {
    if (!isPlaying) {
      lastAutoSaveAtRef.current = 0;
    }
  }, [isPlaying]);

  const handleRemoteSync = (remoteHistory: HistoryEntry[]) => {
    const entry = remoteHistory[0];
    if (!entry) return;

    if (isViewOnly) {
      applyHistoryDisplay(entry);
      return;
    }

    if (currentUrlRef.current && currentUrlRef.current === entry.url && soundRef.current) {
      if (!isLiveStreamRef.current && Number.isFinite(entry.position)) {
        const target = Math.max(0, entry.position);
        void soundRef.current.setPositionAsync(target * 1000).catch(() => {});
        currentTimeRef.current = target;
        setCurrentTime(target);
      }
      return;
    }

    loadFromHistory(entry);
  };

  useEffect(() => {
    const prev = lastSessionStatusRef.current;
    lastSessionStatusRef.current = session.sessionStatus;
    if (prev !== "active" && session.sessionStatus === "active") {
      const entry = history[0];
      if (entry) {
        const start = Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0;
        void loadUrl(entry.url, entry.title, { skipInitialSave: true, startPosition: start });
      } else if (currentUrlRef.current) {
        const start = Math.max(0, currentTimeRef.current);
        void loadUrl(currentUrlRef.current, currentTitleRef.current ?? undefined, {
          skipInitialSave: true,
          startPosition: start,
        });
      }
    }
  }, [currentTime, history, loadUrl, session.sessionStatus]);

  const handleClearHistory = () => {
    if (isViewOnly) return;
    Alert.alert("Clear history", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          setHistory([]);
          void saveHistory([]);
        },
      },
    ]);
  };

  if (isViewOnly) {
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>Audio Player</Text>
        <View style={styles.card}>
          <Text style={styles.nowPlaying}>Now Playing (View Only)</Text>
          <Text style={styles.nowPlayingTitle}>
            {nowPlayingTitle ?? nowPlayingUrl ?? "Nothing loaded"}
          </Text>
          <Text style={styles.meta}>
            {formatTime(currentTime)} / {formatTime(duration)} {isLiveStream ? "(Live)" : ""}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.nowPlaying}>History</Text>
          <ScrollView style={styles.historyList}>
            {history.length === 0 ? (
              <Text style={styles.meta}>No history yet.</Text>
            ) : (
              history.map((entry) => (
                <View key={entry.url} style={styles.historyItem}>
                  <Text style={styles.historyTitle}>{entry.title ?? entry.url}</Text>
                  <Text style={styles.meta}>{formatTime(entry.position)}</Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>

        <NostrSyncPanel
          ref={syncRef}
          secret={secret}
          history={history}
          session={session}
          onHistoryLoaded={(merged) => {
            setHistory(merged);
            void saveHistory(merged);
          }}
          onRemoteSync={handleRemoteSync}
          onTakeOver={handleRemoteSync}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Audio Player</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Stream URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://..."
          placeholderTextColor="#6B7280"
          editable={!isViewOnly}
        />
        <Text style={styles.label}>Title (optional)</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="My playlist"
          placeholderTextColor="#6B7280"
          editable={!isViewOnly}
        />
        <Pressable
          style={[styles.primaryButton, isViewOnly && styles.buttonDisabled]}
          onPress={loadStream}
          disabled={isViewOnly}
        >
          <Text style={styles.primaryButtonText}>Load</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading ? <ActivityIndicator color="#60A5FA" /> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.nowPlaying}>Now Playing</Text>
        <Text style={styles.nowPlayingTitle}>
          {nowPlayingTitle ?? nowPlayingUrl ?? "Nothing loaded"}
        </Text>
        <Text style={styles.meta}>
          {formatTime(currentTime)} / {formatTime(duration)} {isLiveStream ? "(Live)" : ""}
        </Text>
        <View style={styles.row}>
          <Pressable
            style={[styles.secondaryButton, isViewOnly && styles.buttonDisabled]}
            onPress={() => void seekBy(-15)}
            disabled={isViewOnly}
          >
            <Text style={styles.secondaryButtonText}>-15s</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryButton, isViewOnly && styles.buttonDisabled]}
            onPress={togglePlayPause}
            disabled={isViewOnly}
          >
            <Text style={styles.primaryButtonText}>{isPlaying ? "Pause" : "Play"}</Text>
          </Pressable>
          <Pressable
            style={[styles.secondaryButton, isViewOnly && styles.buttonDisabled]}
            onPress={() => void seekBy(15)}
            disabled={isViewOnly}
          >
            <Text style={styles.secondaryButtonText}>+15s</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.nowPlaying}>History</Text>
          {history.length > 0 ? (
            <Pressable onPress={handleClearHistory} disabled={isViewOnly}>
              <Text style={styles.clear}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollView style={styles.historyList}>
          {history.length === 0 ? (
            <Text style={styles.meta}>No history yet.</Text>
          ) : (
            history.map((entry) => (
              <Pressable
                key={entry.url}
                style={styles.historyItem}
                onPress={() => loadFromHistory(entry)}
                disabled={isViewOnly}
              >
                <Text style={styles.historyTitle}>{entry.title ?? entry.url}</Text>
                <Text style={styles.meta}>{formatTime(entry.position)}</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>

      <NostrSyncPanel
        ref={syncRef}
        secret={secret}
        history={history}
        session={session}
        onHistoryLoaded={(merged) => {
          setHistory(merged);
          void saveHistory(merged);
        }}
        onRemoteSync={handleRemoteSync}
        onTakeOver={handleRemoteSync}
      />
    </View>
  );
  }
);

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 32,
  },
  heading: {
    fontSize: 24,
    fontWeight: "700",
    color: "#F9FAFB",
    marginBottom: 12,
  },
  card: {
    backgroundColor: "#1F2937",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  label: {
    color: "#9CA3AF",
    marginBottom: 6,
  },
  input: {
    backgroundColor: "#111827",
    borderRadius: 8,
    padding: 10,
    color: "#F9FAFB",
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: "#374151",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  secondaryButtonText: {
    color: "#E5E7EB",
  },
  row: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    marginTop: 12,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  nowPlaying: {
    color: "#F9FAFB",
    fontSize: 16,
    fontWeight: "600",
  },
  nowPlayingTitle: {
    color: "#E5E7EB",
    marginTop: 6,
  },
  meta: {
    color: "#9CA3AF",
    marginTop: 6,
  },
  error: {
    color: "#FCA5A5",
    marginTop: 8,
  },
  historyList: {
    maxHeight: 220,
  },
  historyItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#374151",
  },
  historyTitle: {
    color: "#F9FAFB",
  },
  clear: {
    color: "#FCA5A5",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
