import { NostrSyncPanel, type NostrSyncPanelHandle } from "@/components/NostrSyncPanel";
import type { SessionStatus } from "@/hooks/useNostrSession";
import { useNostrSession } from "@/hooks/useNostrSession";
import type { HistoryEntry } from "@/lib/history";
import { getHistory, saveHistory } from "@/lib/history";
import * as TrackPlayer from "@/services/HlsTrackPlayer";
import { State, usePlaybackError, usePlaybackIntent, usePlaybackState, useProgress, useStreamReady } from "@/services/HlsTrackPlayer";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import Slider from "@react-native-community/slider";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
  enterPublishMode: () => void;
  enterViewMode: () => void;
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
    const [showUrlInput, setShowUrlInput] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [editingTitleValue, setEditingTitleValue] = useState("");

    // Scrubbing state - when true, we show scrub position instead of actual position
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubPosition, setScrubPosition] = useState(0);
    const [viewOnlyPosition, setViewOnlyPosition] = useState<number | null>(null);
    const [isLiveStream, setIsLiveStream] = useState(false);
    const [probeDuration, setProbeDuration] = useState<number>(0);

    // TrackPlayer hooks for real-time updates
    const { position, duration: vlcDuration, seeking: isSeeking } = useProgress(200);
    const playbackState = usePlaybackState();
    const playbackIntent = usePlaybackIntent();
    const streamInfo = useStreamReady();
    const playbackError = usePlaybackError();
    const hasActiveTrack = Boolean(nowPlayingUrl);
    // Use VLC duration if available, otherwise fall back to probe duration
    const duration = vlcDuration > 0 ? vlcDuration : probeDuration;
    const hasFiniteDuration = Number.isFinite(duration) && duration > 0;
    const effectivePlaybackState = playbackState.state;
    const isPlayingNative = effectivePlaybackState === State.Playing;
    const isBuffering = effectivePlaybackState === State.Buffering;
    const isIntentPlaying = playbackIntent.playing;
    const isPlaying = isPlayingNative;
    const effectiveStateLabel = State[effectivePlaybackState] ?? "Unknown";
    const nativeStateLabel = State[playbackState.state] ?? "Unknown";
    const intentStateLabel = isIntentPlaying ? "Playing" : "Paused";

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
    // Treat true loading separately from an unloaded/empty player state for clearer UI/debug
    const isLoadingState = loading || effectivePlaybackState === State.Buffering;
    const isUnloaded = effectivePlaybackState === State.None;
    const controlsDisabled = isViewOnly || isLoadingState || isUnloaded;

    useEffect(() => {
      isLiveStreamRef.current = isLiveStream;
    }, [isLiveStream]);

    // Update isLiveStream and probeDuration from VLC stream-ready event
    useEffect(() => {
      if (streamInfo) {
        setIsLiveStream(streamInfo.isLive);
        isLiveStreamRef.current = streamInfo.isLive;
        setProbeDuration(streamInfo.duration > 0 ? streamInfo.duration : 0);
      }
    }, [streamInfo]);

    // Display native playback errors
    useEffect(() => {
      if (playbackError) {
        const message = playbackError.detail
          ? `${playbackError.message}: ${playbackError.detail}`
          : playbackError.message;
        setError(message);
        setLoading(false);
      }
    }, [playbackError]);

    useEffect(() => {
      if (playbackState.state !== State.Stopped) return;
      // Don't reset position when stopped - let it stay at the end like web player
      setIsScrubbing(false);
    }, [playbackState.state]);

    useImperativeHandle(ref, () => ({
      enterPublishMode: () => syncRef.current?.startSession(),
      enterViewMode: () => {
        session.setSessionStatus("idle");
        session.clearSessionNotice();
        syncRef.current?.enterViewMode();
      },
      refreshSession: () => syncRef.current?.refreshSession(),
      syncNow: () => syncRef.current?.syncNow(),
      getSessionStatus: () => session.sessionStatus,
    }));

    const rehydrateIfStopped = useCallback(async () => {
      if (playbackState.state !== State.Stopped) return;

      const active = await TrackPlayer.getActiveTrack();
      const urlToLoad = active?.url ?? currentUrlRef.current;
      if (!urlToLoad) return;

      const titleToLoad = active?.title ?? currentTitleRef.current ?? undefined;

      await TrackPlayer.reset();
      // Start from beginning when rehydrating after stop (like web player)
      await TrackPlayer.add(
        {
          id: urlToLoad,
          url: urlToLoad,
          title: titleToLoad || "Stream",
          artist: urlToLoad,
        },
        { startPosition: 0, autoplay: false }
      );
    }, [playbackState.state]);

    const handlePlay = useCallback(async () => {
      if (isViewOnly) return;
      try {
        await rehydrateIfStopped();
        await TrackPlayer.play();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Playback error");
      }
    }, [isViewOnly, rehydrateIfStopped]);

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

    // Stop and clear the player when session becomes inactive to avoid background audio
    useEffect(() => {
      if (session.sessionStatus === "active") return;
      (async () => {
        try {
          await TrackPlayer.stop();
          await TrackPlayer.reset();
          setIsLiveStream(false);
          isLiveStreamRef.current = false;
          setProbeDuration(0);
        } catch {
          // Ignore cleanup failures
        }
      })();
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
        options?: { skipInitialSave?: boolean; startPosition?: number | null; autoPlay?: boolean }
      ) => {
        if (!urlToLoad) return;
        setLoading(true);
        setError(null);

        try {
          // Reset the player and add the new track
          // Live status and duration will come from stream-ready event (native probes with AVURLAsset, fallback to VLC)
          await TrackPlayer.reset();

          const startPosition = options?.startPosition ?? null;
          const validStartPosition = Number.isFinite(startPosition) && (startPosition as number) > 0
            ? (startPosition as number)
            : undefined;

          // Pass startPosition and autoplay to native - it handles seeking and autoplay
          await TrackPlayer.add(
            {
              id: urlToLoad,
              url: urlToLoad,
              title: resolvedTitle || "Stream",
              artist: urlToLoad,
            },
            {
              startPosition: validStartPosition,
              autoplay: options?.autoPlay ?? false,
            }
          );

          currentUrlRef.current = urlToLoad;
          currentTitleRef.current = resolvedTitle ?? null;
          setNowPlayingUrl(urlToLoad);
          setNowPlayingTitle(resolvedTitle ?? null);

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

    const applyHistoryDisplay = useCallback(
      (entry: HistoryEntry) => {
        currentUrlRef.current = entry.url;
        currentTitleRef.current = entry.title ?? null;
        setNowPlayingUrl(entry.url);
        setNowPlayingTitle(entry.title ?? null);
        if (session.sessionStatus !== "active") {
          setViewOnlyPosition(Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0);
        }
      },
      [session.sessionStatus]
    );

    const loadFromHistory = useCallback(
      (entry: HistoryEntry, options?: { allowViewOnly?: boolean; autoPlay?: boolean }) => {
        if (!entry) return;
        if (isViewOnly && !options?.allowViewOnly) return;

        if (isViewOnly) {
          applyHistoryDisplay(entry);
          setViewOnlyPosition(Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0);
          return;
        }

        const start = Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0;

        // Native handles seeking to start position and autoplay
        void loadUrl(entry.url, entry.title, {
          skipInitialSave: true,
          startPosition: start,
          autoPlay: options?.autoPlay ?? false,
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
        if (session.sessionStatus !== "active" && stored[0]) {
          setViewOnlyPosition(
            Number.isFinite(stored[0].position) ? Math.max(0, stored[0].position) : 0
          );
        }
      })();

      return () => {
        mounted = false;
      };
    }, [applyHistoryDisplay, session.sessionStatus]);

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
      if (isIntentPlaying) {
        await handlePause();
      } else {
        await handlePlay();
      }
    };

    const handleJumpBackward = async () => {
      if (isLiveStreamRef.current) return;
      try {
        await TrackPlayer.jumpBackward();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Jump backward failed");
      }
    };

    const handleJumpForward = async () => {
      if (isLiveStreamRef.current) return;
      try {
        await TrackPlayer.jumpForward();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Jump forward failed");
      }
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
        setViewOnlyPosition(Number.isFinite(entry.position) ? Math.max(0, entry.position) : 0);
        return;
      }

      const currentTrack = await TrackPlayer.getActiveTrack();
      if (currentUrlRef.current && currentUrlRef.current === entry.url && currentTrack) {
        // Same track already playing - don't seek to remote position
        // Our current playback position is more accurate than the stale remote sync
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

    const handleRemoveFromHistory = (urlToRemove: string, entryTitle?: string) => {
      if (isViewOnly) return;
      Alert.alert(
        "Remove from history",
        `Remove "${entryTitle || urlToRemove}"?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => {
              const next = history.filter((entry) => entry.url !== urlToRemove);
              persistHistory(next);
            },
          },
        ]
      );
    };

    const startEditingTitle = () => {
      setEditingTitleValue(nowPlayingTitle ?? "");
      setIsEditingTitle(true);
    };

    const cancelEditingTitle = () => {
      setIsEditingTitle(false);
      setEditingTitleValue("");
    };

    const saveEditingTitle = () => {
      if (isViewOnly || !currentUrlRef.current) return;
      const newTitle = editingTitleValue.trim();
      currentTitleRef.current = newTitle || null;
      setNowPlayingTitle(newTitle || null);
      // Update in history as well
      setHistory((prev) => {
        const updated = prev.map((entry) =>
          entry.url === currentUrlRef.current
            ? { ...entry, title: newTitle || undefined }
            : entry
        );
        void saveHistory(updated);
        return updated;
      });
      setIsEditingTitle(false);
      setEditingTitleValue("");
    };

    // Seek slider handlers
    const handleSeekStart = () => {
      if (isLiveStreamRef.current) return;
      setIsScrubbing(true);
      setScrubPosition(displayPosition);
    };

    const handleSeekChange = (value: number) => {
      if (isLiveStreamRef.current) return;
      setScrubPosition(value);
    };

    const handleSeekComplete = async (value: number) => {
      if (isLiveStreamRef.current) return;
      setScrubPosition(value);
      await seekTo(value);
      setIsScrubbing(false);
    };

    // Display position - trust native position directly, use scrub position during slider interaction
    // When stopped, keep showing the last position (like web player shows position at end)
    const computedDisplayPosition = useMemo(() => {
      if (isScrubbing) return scrubPosition;
      if (isViewOnly) return viewOnlyPosition ?? position;
      return position;
    }, [
      isScrubbing,
      isViewOnly,
      position,
      scrubPosition,
      viewOnlyPosition,
    ]);

    const displayPosition = hasActiveTrack ? computedDisplayPosition : 0;
    const displayDuration = hasActiveTrack && hasFiniteDuration ? duration : null;
    const displayPositionLabel = hasActiveTrack ? displayPosition : null;
    const seekDisabled = controlsDisabled || isLiveStream || !hasActiveTrack || !hasFiniteDuration;

    if (isViewOnly) {
      const isLiveDisplay = false;
      const viewOnlyDisplayPos = displayPosition;
      const viewOnlyDuration = displayDuration;
      return (
        <View style={styles.container}>
          <Text style={styles.heading}>Audio Player</Text>
          <View style={styles.card}>
            <Text style={styles.nowPlaying}>Now Playing (View Only)</Text>
            <Text style={styles.nowPlayingTitle}>
              {nowPlayingTitle ?? nowPlayingUrl ?? "Nothing loaded"}
            </Text>
            <Text style={styles.meta}>
              {formatTime(viewOnlyDisplayPos)} / {formatTime(viewOnlyDuration)} {isLiveDisplay ? "(Live)" : ""}
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
                    <View style={styles.historyContent}>
                      <Text style={styles.historyTitle}>{entry.title || "Untitled"}</Text>
                      <Text style={styles.historyUrl} numberOfLines={1}>{entry.url}</Text>
                      <Text style={styles.historyMeta}>{formatTime(entry.position)}</Text>
                    </View>
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
            <Text style={styles.label}>Title (optional)</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="My playlist"
              placeholderTextColor="#6B7280"
              editable={!isViewOnly}
              autoFocus
            />
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
          {nowPlayingUrl ? (
            <>
              {isEditingTitle ? (
                <View style={styles.editTitleRow}>
                  <TextInput
                    style={styles.editTitleInput}
                    value={editingTitleValue}
                    onChangeText={setEditingTitleValue}
                    placeholder="Enter title..."
                    placeholderTextColor="#6B7280"
                    autoFocus
                  />
                  <Pressable style={styles.saveButton} onPress={saveEditingTitle}>
                    <MaterialIcons name="check" size={20} color="#10B981" />
                  </Pressable>
                  <Pressable style={styles.cancelEditButton} onPress={cancelEditingTitle}>
                    <MaterialIcons name="close" size={20} color="#9CA3AF" />
                  </Pressable>
                </View>
              ) : (
                <View style={styles.titleRow}>
                  <Text style={styles.nowPlayingTitleText}>
                    {nowPlayingTitle || "Untitled"}
                  </Text>
                  {!isViewOnly && (
                    <Pressable style={styles.editButton} onPress={startEditingTitle}>
                      <MaterialIcons name="edit" size={16} color="#9CA3AF" />
                    </Pressable>
                  )}
                </View>
              )}
              <Text style={styles.nowPlayingUrl} numberOfLines={1}>
                {nowPlayingUrl}
              </Text>
              <Text style={styles.debugMeta}>Intent: {intentStateLabel}</Text>
              <Text style={styles.debugMeta}>Native: {nativeStateLabel}</Text>
              <Text style={styles.debugMeta}>Effective: {effectiveStateLabel}</Text>
              <Text style={styles.debugMeta}>Duration: VLC={vlcDuration.toFixed(1)} Probe={probeDuration.toFixed(1)}</Text>
              {isBuffering ? <Text style={styles.debugMeta}>Buffering</Text> : null}
              {isLoadingState ? <Text style={styles.debugMeta}>Loading</Text> : null}
              {isUnloaded ? <Text style={styles.debugMeta}>Unloaded</Text> : null}
              {isLiveStream ? <Text style={styles.debugMeta}>Live stream</Text> : null}
            </>
          ) : (
            <Text style={styles.nowPlayingTitle}>Nothing loaded</Text>
          )}
          <View style={styles.seekRow}>
            {loading || isLiveStream ? <View style={styles.seekPlaceholder} /> : (
              <Text style={styles.meta}>{formatTime(displayPositionLabel)}</Text>
            )}
            <Text style={styles.meta}>{loading ? "--:--" : isLiveStream ? "Live" : formatTime(displayDuration)}</Text>
          </View>

          {/* Seek Slider */}
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={hasFiniteDuration ? duration : 1}
            value={hasActiveTrack && hasFiniteDuration ? displayPosition : 0}
            onSlidingStart={handleSeekStart}
            onValueChange={handleSeekChange}
            onSlidingComplete={handleSeekComplete}
            disabled={seekDisabled}
            minimumTrackTintColor="#60A5FA"
            maximumTrackTintColor="#374151"
            thumbTintColor="#93C5FD"
          />

          <View style={[styles.row, styles.rowCentered]}>
            <Pressable
              style={[styles.secondaryButton, seekDisabled && styles.buttonDisabled]}
              onPress={() => void handleJumpBackward()}
              disabled={seekDisabled}
            >
              <Text style={styles.secondaryButtonText}>-15s</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryButton, controlsDisabled && styles.buttonDisabled]}
              onPress={togglePlayPause}
              disabled={controlsDisabled}
            >
              <MaterialIcons
                name={isIntentPlaying ? "pause" : "play-arrow"}
                size={26}
                color="#F9FAFB"
              />
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, seekDisabled && styles.buttonDisabled]}
              onPress={() => void handleJumpForward()}
              disabled={seekDisabled}
            >
              <Text style={styles.secondaryButtonText}>+30s</Text>
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
                <View key={entry.url} style={styles.historyItem}>
                  <Pressable
                    style={styles.historyContent}
                    onPress={() => loadFromHistory(entry, { autoPlay: true })}
                    disabled={isViewOnly}
                  >
                    <Text style={styles.historyTitle}>{entry.title || "Untitled"}</Text>
                    <Text style={styles.historyUrl} numberOfLines={1}>{entry.url}</Text>
                    <Text style={styles.historyMeta}>{formatTime(entry.position)}</Text>
                  </Pressable>
                  {!isViewOnly && (
                    <Pressable
                      style={styles.removeButton}
                      onPress={() => handleRemoveFromHistory(entry.url, entry.title)}
                    >
                      <MaterialIcons name="close" size={18} color="#9CA3AF" />
                    </Pressable>
                  )}
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
  seekPlaceholder: {
    width: 1,
  },
  slider: {
    width: "100%",
    height: 40,
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
  nowPlayingTitleInput: {
    color: "#F9FAFB",
    fontSize: 16,
    fontWeight: "500",
    marginTop: 6,
    padding: 0,
  },
  nowPlayingUrl: {
    color: "#6B7280",
    fontSize: 12,
    marginTop: 4,
  },
  meta: {
    color: "#9CA3AF",
    marginTop: 6,
  },
  debugMeta: {
    color: "#9CA3AF",
    marginTop: 4,
    fontSize: 12,
  },
  error: {
    color: "#FCA5A5",
    marginTop: 8,
  },
  historyList: {
    maxHeight: 220,
  },
  historyItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#374151",
  },
  historyContent: {
    flex: 1,
  },
  historyTitle: {
    color: "#F9FAFB",
    fontWeight: "500",
  },
  historyUrl: {
    color: "#6B7280",
    fontSize: 12,
    marginTop: 2,
  },
  historyMeta: {
    color: "#9CA3AF",
    fontSize: 12,
    marginTop: 4,
  },
  removeButton: {
    padding: 8,
    marginLeft: 8,
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
  editTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  editTitleInput: {
    flex: 1,
    backgroundColor: "#111827",
    borderRadius: 8,
    padding: 10,
    color: "#F9FAFB",
    fontSize: 16,
  },
  saveButton: {
    padding: 8,
  },
  cancelEditButton: {
    padding: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  nowPlayingTitleText: {
    color: "#E5E7EB",
    fontSize: 16,
    fontWeight: "500",
    flex: 1,
  },
  editButton: {
    padding: 4,
  },
});

AudioPlayer.displayName = "AudioPlayer";
