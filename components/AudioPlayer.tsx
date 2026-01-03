import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";
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
import type { HistoryEntry } from "@/lib/history";
import { getHistory, saveHistory } from "@/lib/history";
import { NostrSyncPanel } from "@/components/NostrSyncPanel";
import { useNostrSession } from "@/hooks/useNostrSession";

interface AudioPlayerProps {
  secret: string;
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ secret }: AudioPlayerProps) {
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

  const pendingSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSeekAttemptsRef = useRef(0);
  const pendingSeekPositionRef = useRef<number | null>(null);
  const seekingToTargetRef = useRef(false);
  const isLiveStreamRef = useRef(false);

  const session = useNostrSession({ secret });
  const isViewOnly = session.sessionStatus !== "active";

  useEffect(() => {
    isLiveStreamRef.current = isLiveStream;
  }, [isLiveStream]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const stored = await getHistory();
      if (!mounted) return;
      setHistory(stored);
      if (stored[0]) {
        loadFromHistory(stored[0]);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        void soundRef.current.unloadAsync();
      }
    };
  }, []);

  const persistHistory = useCallback((next: HistoryEntry[]) => {
    setHistory(next);
    void saveHistory(next);
  }, []);

  const saveHistoryEntry = useCallback(
    (position?: number, options?: { allowLive?: boolean }) => {
      if (isViewOnly) return;
      if (!currentUrlRef.current) return;
      if (isLiveStreamRef.current && !options?.allowLive) return;

      const now = new Date().toISOString();
      const entry: HistoryEntry = {
        url: currentUrlRef.current,
        title: currentTitleRef.current ?? undefined,
        lastPlayedAt: now,
        position: Number.isFinite(position) ? (position as number) : currentTime,
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

  const schedulePendingSeekRetry = () => {
    if (pendingSeekTimerRef.current) return;
    pendingSeekTimerRef.current = setTimeout(() => {
      pendingSeekTimerRef.current = null;
      applyPendingSeek();
    }, 250);
  };

  const applyPendingSeek = () => {
    const pending = pendingSeekPositionRef.current;
    const sound = soundRef.current;
    if (!sound || pending === null) return;
    if (isLiveStreamRef.current) {
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      return;
    }
    if (!Number.isFinite(pending) || pending < 0) {
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      return;
    }
    if (pendingSeekAttemptsRef.current >= 20) {
      console.warn("Seek to saved position failed after max retries");
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      return;
    }

    if (Math.abs(currentTime - pending) <= 0.5) {
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      if (pendingSeekTimerRef.current) {
        clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      return;
    }

    if (seekingToTargetRef.current) return;

    pendingSeekAttemptsRef.current += 1;
    seekingToTargetRef.current = true;
    void sound
      .setPositionAsync(Math.max(0, pending * 1000))
      .catch(() => {
        schedulePendingSeekRetry();
      })
      .finally(() => {
        seekingToTargetRef.current = false;
      });

    schedulePendingSeekRetry();
  };

  const onPlaybackStatusUpdate = (status: Audio.AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) {
        setError(status.error);
      }
      return;
    }

    setIsPlaying(status.isPlaying);
    setCurrentTime(status.positionMillis / 1000);

    if (typeof status.durationMillis === "number") {
      setDuration(status.durationMillis / 1000);
      setIsLiveStream(false);
    } else {
      setDuration(null);
      setIsLiveStream(true);
    }

    if (pendingSeekPositionRef.current !== null) {
      applyPendingSeek();
    }
  };

  const loadUrl = useCallback(
    async (urlToLoad: string, resolvedTitle?: string, options?: { forceReset?: boolean }) => {
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
        } else {
          setDuration(null);
          setIsLiveStream(true);
        }

        saveHistoryEntry(0, { allowLive: true });

        if (options?.forceReset) {
          pendingSeekPositionRef.current = null;
          pendingSeekAttemptsRef.current = 0;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audio");
      } finally {
        setLoading(false);
      }
    },
    [saveHistoryEntry]
  );

  const loadFromHistory = useCallback(
    (entry: HistoryEntry, options?: { forceReset?: boolean }) => {
      if (isViewOnly) return;
      if (!entry) return;
      pendingSeekPositionRef.current = entry.position;
      pendingSeekAttemptsRef.current = 0;
      seekingToTargetRef.current = false;
      if (pendingSeekTimerRef.current) {
        clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      void loadUrl(entry.url, entry.title, options);
    },
    [isViewOnly, loadUrl]
  );

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
    if (!isPlaying || isLiveStream) return;
    const timer = setInterval(() => {
      saveHistoryEntry(currentTime);
    }, 5000);
    return () => clearInterval(timer);
  }, [isPlaying, isLiveStream, currentTime, saveHistoryEntry]);

  const handleRemoteSync = (remoteHistory: HistoryEntry[]) => {
    const entry = remoteHistory[0];
    if (!entry) return;

    if (isViewOnly) {
      currentUrlRef.current = entry.url;
      currentTitleRef.current = entry.title ?? null;
      setNowPlayingUrl(entry.url);
      setNowPlayingTitle(entry.title ?? null);
      setCurrentTime(Number.isFinite(entry.position) ? entry.position : 0);
      return;
    }

    if (currentUrlRef.current && currentUrlRef.current === entry.url && soundRef.current) {
      if (!isLiveStreamRef.current && Number.isFinite(entry.position)) {
        const delta = Math.abs(currentTime - entry.position);
        if (delta > 0.5) {
          pendingSeekPositionRef.current = entry.position;
          pendingSeekAttemptsRef.current = 0;
          seekingToTargetRef.current = false;
          applyPendingSeek();
        }
      }
      return;
    }

    loadFromHistory(entry, { forceReset: true });
  };

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
