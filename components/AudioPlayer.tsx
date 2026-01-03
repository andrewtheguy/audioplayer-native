import { NostrSyncPanel, type NostrSyncPanelHandle } from "@/components/NostrSyncPanel";
import type { SessionStatus } from "@/hooks/useNostrSession";
import { useNostrSession } from "@/hooks/useNostrSession";
import type { HistoryEntry } from "@/lib/history";
import { getHistory, saveHistory } from "@/lib/history";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import Slider from "@react-native-community/slider";
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
import TrackPlayer, {
  State,
  usePlaybackState,
  useProgress,
} from "react-native-track-player";

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
  if (seconds === null || !Number.isFinite(seconds)) return "--:--:--";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  ({ secret, onSessionStatusChange }, ref) => {
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    const [nowPlayingUrl, setNowPlayingUrl] = useState<string | null>(null);
    const [nowPlayingTitle, setNowPlayingTitle] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [volume, setVolume] = useState(1);
    const [showUrlInput, setShowUrlInput] = useState(false);

    // Scrubbing state - when true, we show scrub position instead of actual position
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubPosition, setScrubPosition] = useState(0);

    // TrackPlayer hooks for real-time updates
    const { position, duration } = useProgress(500);
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const isLiveStream = !duration || duration === 0 || !Number.isFinite(duration);

    const currentUrlRef = useRef<string | null>(null);
    const currentTitleRef = useRef<string | null>(null);
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

    const handlePlay = useCallback(async () => {
      if (isViewOnly) return;
      try {
        await TrackPlayer.play();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Playback error");
      }
    }, [isViewOnly]);

    const handlePause = useCallback(async () => {
      if (isViewOnly) return;
      try {
        await TrackPlayer.pause();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Playback error");
      }
    }, [isViewOnly]);

    const seekTo = useCallback(async (targetSeconds: number) => {
      if (!Number.isFinite(targetSeconds)) return;
      const next = Math.max(0, targetSeconds);
      try {
        await TrackPlayer.seekTo(next);
      } catch {
        // Ignore seek failures
      }
    }, []);

    const applyVolume = useCallback(async (nextVolume: number) => {
      const clamped = Math.min(1, Math.max(0, nextVolume));
      setVolume(clamped);
      try {
        await TrackPlayer.setVolume(clamped);
      } catch {
        // Ignore volume failures
      }
    }, []);

    // Stop playback when session becomes inactive
    useEffect(() => {
      if (session.sessionStatus === "active") return;
      void TrackPlayer.stop().catch(() => {});
    }, [session.sessionStatus]);

    const persistHistory = useCallback((next: HistoryEntry[]) => {
      setHistory(next);
      void saveHistory(next);
    }, []);

    const saveHistoryEntry = useCallback(
      (positionToSave?: number, options?: { allowLive?: boolean }) => {
        if (isViewOnly) return;
        if (!currentUrlRef.current) return;
        if (isLiveStreamRef.current && !options?.allowLive) return;

        const pos = Number.isFinite(positionToSave) ? (positionToSave as number) : position;
        const now = new Date().toISOString();
        const entry: HistoryEntry = {
          url: currentUrlRef.current,
          title: currentTitleRef.current ?? undefined,
          lastPlayedAt: now,
          position: pos,
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
      [position, isViewOnly]
    );

    // Auto-save every 5 seconds while playing
    useEffect(() => {
      if (!isPlaying || isViewOnly || isLiveStreamRef.current) return;
      if (!currentUrlRef.current) return;

      if (Date.now() - lastAutoSaveAtRef.current >= 5000) {
        lastAutoSaveAtRef.current = Date.now();
        saveHistoryEntry(position);
      }
    }, [isPlaying, isViewOnly, position, saveHistoryEntry]);

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
          // Reset the player and add the new track
          await TrackPlayer.reset();

          await TrackPlayer.add({
            id: urlToLoad,
            url: urlToLoad,
            title: resolvedTitle || "Stream",
            artist: urlToLoad,
          });

          currentUrlRef.current = urlToLoad;
          currentTitleRef.current = resolvedTitle ?? null;
          setNowPlayingUrl(urlToLoad);
          setNowPlayingTitle(resolvedTitle ?? null);

          // Apply current volume
          await TrackPlayer.setVolume(volume);

          // Seek to start position if provided
          const startPosition = options?.startPosition ?? null;
          if (startPosition !== null && Number.isFinite(startPosition) && startPosition > 0) {
            await TrackPlayer.seekTo(startPosition);
          }

          if (!options?.skipInitialSave) {
            saveHistoryEntry(0, { allowLive: true });
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load audio");
        } finally {
          setLoading(false);
        }
      },
      [saveHistoryEntry, volume]
    );

    const applyHistoryDisplay = useCallback((entry: HistoryEntry) => {
      currentUrlRef.current = entry.url;
      currentTitleRef.current = entry.title ?? null;
      setNowPlayingUrl(entry.url);
      setNowPlayingTitle(entry.title ?? null);
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

        void loadUrl(entry.url, entry.title, {
          skipInitialSave: true,
          startPosition: start,
        });
      },
      [applyHistoryDisplay, isViewOnly, loadUrl]
    );

    // Load history on mount
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
      if (isPlaying) {
        await handlePause();
      } else {
        await handlePlay();
      }
    };

    const seekBy = async (deltaSeconds: number) => {
      if (isViewOnly || isLiveStreamRef.current) return;
      const next = Math.max(0, position + deltaSeconds);
      await seekTo(next);
    };

    // Reset auto-save timer when playback stops
    useEffect(() => {
      if (!isPlaying) {
        lastAutoSaveAtRef.current = 0;
      }
    }, [isPlaying]);

    const handleRemoteSync = async (remoteHistory: HistoryEntry[]) => {
      const entry = remoteHistory[0];
      if (!entry) return;

      if (isViewOnly) {
        applyHistoryDisplay(entry);
        return;
      }

      const currentTrack = await TrackPlayer.getActiveTrack();
      if (currentUrlRef.current && currentUrlRef.current === entry.url && currentTrack) {
        if (!isLiveStreamRef.current && Number.isFinite(entry.position)) {
          const target = Math.max(0, entry.position);
          await TrackPlayer.seekTo(target);
        }
        return;
      }

      loadFromHistory(entry);
    };

    // Handle session becoming active
    useEffect(() => {
      const prev = lastSessionStatusRef.current;
      lastSessionStatusRef.current = session.sessionStatus;
      if (prev !== "active" && session.sessionStatus === "active") {
        const entry = history[0];
        if (entry) {
          const start = Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0;
          void loadUrl(entry.url, entry.title, { skipInitialSave: true, startPosition: start });
        } else if (currentUrlRef.current) {
          void loadUrl(currentUrlRef.current, currentTitleRef.current ?? undefined, {
            skipInitialSave: true,
            startPosition: 0,
          });
        }
      }
    }, [history, loadUrl, session.sessionStatus]);

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

    // Seek slider handlers
    const handleSeekStart = () => {
      setIsScrubbing(true);
      setScrubPosition(position);
    };

    const handleSeekChange = (value: number) => {
      setScrubPosition(value);
    };

    const handleSeekComplete = async (value: number) => {
      setIsScrubbing(false);
      await seekTo(value);
    };

    // Display position (scrub position while dragging, actual position otherwise)
    const displayPosition = isScrubbing ? scrubPosition : position;

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
              {formatTime(position)} / {formatTime(duration)} {isLiveStream ? "(Live)" : ""}
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

    const handleLoadStream = () => {
      loadStream();
      setShowUrlInput(false);
      setUrl("");
      setTitle("");
    };

    const handleCancelUrlInput = () => {
      setShowUrlInput(false);
      setUrl("");
      setTitle("");
      setError(null);
    };

    return (
      <View style={styles.container}>
        <Text style={styles.heading}>Audio Player</Text>

        {!showUrlInput ? (
          <Pressable
            style={[styles.addUrlButton, isViewOnly && styles.buttonDisabled]}
            onPress={() => setShowUrlInput(true)}
            disabled={isViewOnly}
          >
            <MaterialIcons name="add" size={20} color="#F9FAFB" />
            <Text style={styles.addUrlButtonText}>Add URL</Text>
          </Pressable>
        ) : (
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
              autoFocus
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
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.primaryButton, styles.flexButton, isViewOnly && styles.buttonDisabled]}
                onPress={handleLoadStream}
                disabled={isViewOnly}
              >
                <Text style={styles.primaryButtonText}>Load</Text>
              </Pressable>
              <Pressable
                style={[styles.cancelButton, styles.flexButton]}
                onPress={handleCancelUrlInput}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {loading ? <ActivityIndicator color="#60A5FA" /> : null}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.nowPlaying}>Now Playing</Text>
          <Text style={styles.nowPlayingTitle}>
            {nowPlayingTitle ?? nowPlayingUrl ?? "Nothing loaded"}
          </Text>
          <View style={styles.seekRow}>
            <Text style={styles.meta}>{formatTime(displayPosition)}</Text>
            <Text style={styles.meta}>{isLiveStream ? "Live" : formatTime(duration)}</Text>
          </View>

          {/* Seek Slider */}
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={duration || 1}
            value={displayPosition}
            onSlidingStart={handleSeekStart}
            onValueChange={handleSeekChange}
            onSlidingComplete={handleSeekComplete}
            disabled={isViewOnly || isLiveStream || !duration}
            minimumTrackTintColor="#60A5FA"
            maximumTrackTintColor="#374151"
            thumbTintColor="#93C5FD"
          />

          <View style={[styles.row, styles.rowCentered]}>
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
              <MaterialIcons
                name={isPlaying ? "pause" : "play-arrow"}
                size={26}
                color="#F9FAFB"
              />
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, isViewOnly && styles.buttonDisabled]}
              onPress={() => void seekBy(30)}
              disabled={isViewOnly}
            >
              <Text style={styles.secondaryButtonText}>+30s</Text>
            </Pressable>
          </View>

          <View style={styles.volumeRow}>
            <Text style={styles.meta}>Volume</Text>
            <Text style={styles.meta}>{Math.round(volume * 100)}%</Text>
          </View>

          {/* Volume Slider */}
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            value={volume}
            onValueChange={(value) => void applyVolume(value)}
            disabled={isViewOnly}
            minimumTrackTintColor="#60A5FA"
            maximumTrackTintColor="#374151"
            thumbTintColor="#93C5FD"
          />
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
    paddingVertical: 12,
    paddingHorizontal: 18,
    minWidth: 110,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
    fontSize: 16,
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
  rowCentered: {
    justifyContent: "center",
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  seekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  slider: {
    width: "100%",
    height: 40,
  },
  volumeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
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
  addUrlButton: {
    backgroundColor: "#374151",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    marginBottom: 16,
  },
  addUrlButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
    fontSize: 16,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  flexButton: {
    flex: 1,
  },
  cancelButton: {
    backgroundColor: "#374151",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: "center",
  },
  cancelButtonText: {
    color: "#F9FAFB",
    fontWeight: "600",
    fontSize: 16,
  },
});

AudioPlayer.displayName = "AudioPlayer";
