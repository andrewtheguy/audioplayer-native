import { useEffect, useState } from "react";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const LINKING_ERROR =
  "The HLSPlayer native module is not linked. Make sure you have rebuilt the iOS app.";

const NativeHlsPlayer = NativeModules.HLSPlayerModule
  ? NativeModules.HLSPlayerModule
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      }
    );

const emitter = new NativeEventEmitter(NativeHlsPlayer);

export enum State {
  None = 0,
  Ready = 1,
  Playing = 2,
  Paused = 3,
  Stopped = 4,
  Buffering = 5,
  Connecting = 6,
}

export enum Capability {
  Play = "play",
  Pause = "pause",
  Stop = "stop",
  SeekTo = "seekTo",
  JumpForward = "jumpForward",
  JumpBackward = "jumpBackward",
  SkipToNext = "skipToNext",
  SkipToPrevious = "skipToPrevious",
}

// These enums are kept for API compatibility with the previous TrackPlayer setup.
export enum IOSCategory {
  Playback = "playback",
}

export enum IOSCategoryMode {
  Default = "default",
}

export enum IOSCategoryOptions {
  AllowAirPlay = "allowAirPlay",
  AllowBluetooth = "allowBluetooth",
  AllowBluetoothA2DP = "allowBluetoothA2DP",
}

export type Track = {
  id: string;
  url: string;
  title?: string;
  artist?: string;
};

export type Progress = {
  position: number;
  duration: number;
  buffered?: number;
  seeking?: boolean;
};

export type PlaybackState = { state: State };
export type PlaybackIntent = { playing: boolean };
export type StreamReadyInfo = { position: number; duration: number; isLive: boolean };

export type HlsPlayerEvent =
  | "remote-play"
  | "remote-pause"
  | "remote-stop"
  | "remote-seek"
  | "remote-jump-forward"
  | "remote-jump-backward"
  | "remote-next"
  | "remote-previous"
  | "playback-error"
  | "playback-state"
  | "playback-progress"
  | "playback-intent"
  | "stream-ready"
  | "stream-info"
  | "seek-started"
  | "seek-completed";

export type AddOptions = {
  startPosition?: number;
  autoplay?: boolean;
};

type EventListener = (payload?: any) => void;

type Subscription = {
  remove: () => void;
};

let activeTrack: Track | null = null;
let playbackState: PlaybackState = { state: State.None };

function ensureIOS(): void {
  if (Platform.OS !== "ios") {
    throw new Error("HlsTrackPlayer is only available on iOS.");
  }
}

function mapStateString(nextState?: string): State {
  switch (nextState) {
    case "playing":
      return State.Playing;
    case "paused":
      return State.Paused;
    case "stopped":
      return State.Stopped;
    case "ready":
      return State.Ready;
    case "buffering":
      return State.Buffering;
    default:
      return State.None;
  }
}

function stateToString(state: State): string {
  switch (state) {
    case State.Playing:
      return "playing";
    case State.Paused:
      return "paused";
    case State.Stopped:
      return "stopped";
    case State.Ready:
      return "ready";
    case State.Buffering:
      return "buffering";
    default:
      return "none";
  }
}

function emitPlaybackState(next: State): void {
  playbackState = { state: next };
  const raw = stateToString(next);
  (emitter as any)?.emit?.("playback-state", { state: raw });
}

function emitPlaybackIntent(playing: boolean): void {
  (emitter as any)?.emit?.("playback-intent", { playing });
}

function attachCoreListeners(): void {
  emitter.removeAllListeners("playback-state");
  emitter.addListener("playback-state", (payload?: { state?: string }) => {
    playbackState = { state: mapStateString(payload?.state) };
  });
}

export function registerPlaybackService(factory: () => void | Promise<void>): void {
  // Immediately invoke to mirror TrackPlayer.registerPlaybackService semantics
  void factory();
}

export async function updateOptions(options?: {
  forwardJumpInterval?: number;
  backwardJumpInterval?: number;
}): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.configure({
    forwardInterval: options?.forwardJumpInterval,
    backwardInterval: options?.backwardJumpInterval,
  });
}

export async function setupPlayer(_options?: {
  iosCategory?: IOSCategory;
  iosCategoryMode?: IOSCategoryMode;
  iosCategoryOptions?: IOSCategoryOptions[];
  autoHandleInterruptions?: boolean;
  waitForBuffer?: boolean;
  minBuffer?: number;
  maxBuffer?: number;
  playBuffer?: number;
  backBuffer?: number;
}): Promise<void> {
  ensureIOS();
  attachCoreListeners();
  await NativeHlsPlayer.initialize();
}

export async function add(track: Track, options?: AddOptions): Promise<void> {
  ensureIOS();
  activeTrack = track;
  await NativeHlsPlayer.load(
    track.url,
    track.title ?? track.url,
    options?.startPosition ?? null,
    options?.autoplay ?? false
  );
  await NativeHlsPlayer.setNowPlaying({
    title: track.title ?? "Stream",
    artist: track.artist ?? "",
    url: track.url,
  });
  // Don't emit Ready immediately - native will emit stream-ready when actually ready
}

export async function play(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.play();
  emitPlaybackIntent(true);
  emitPlaybackState(State.Playing);
}

export async function pause(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.pause();
  emitPlaybackIntent(false);
  emitPlaybackState(State.Paused);
}

export async function stop(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.stop();
  emitPlaybackIntent(false);
  emitPlaybackState(State.Stopped);
}

export async function reset(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.reset();
  emitPlaybackIntent(false);
  emitPlaybackState(State.Stopped);
  activeTrack = null;
}

export async function seekTo(position: number): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.seekTo(position);
}

export async function getProgress(): Promise<Progress> {
  ensureIOS();
  const progress = await NativeHlsPlayer.getProgress();
  return {
    position: Number(progress?.position ?? 0),
    duration: Number(progress?.duration ?? 0),
    buffered: Number(progress?.buffered ?? 0),
  };
}

export async function getPlaybackState(): Promise<PlaybackState> {
  ensureIOS();
  return playbackState;
}

export async function getActiveTrack(): Promise<Track | null> {
  ensureIOS();
  return activeTrack;
}

export function addEventListener(event: HlsPlayerEvent, listener: EventListener): Subscription {
  const subscription = emitter.addListener(event, listener);
  return { remove: () => subscription.remove() };
}

export function usePlaybackState(): PlaybackState {
  const [state, setState] = useState<PlaybackState>(playbackState);

  useEffect(() => {
    const sub = emitter.addListener("playback-state", (payload?: { state?: string }) => {
      const next = { state: mapStateString(payload?.state) };
      playbackState = next;
      setState(next);
    });
    return () => sub.remove();
  }, []);

  return state;
}

export function useProgress(updateInterval: number = 250): Progress {
  const [progress, setProgress] = useState<Progress>({ position: 0, duration: 0, buffered: 0, seeking: false });

  useEffect(() => {
    const sub = emitter.addListener("playback-progress", (payload?: Progress) => {
      setProgress({
        position: Number(payload?.position ?? 0),
        duration: Number(payload?.duration ?? 0),
        buffered: Number(payload?.buffered ?? 0),
        seeking: Boolean(payload?.seeking),
      });
    });

    return () => {
      sub.remove();
    };
  }, [updateInterval]);

  return progress;
}

export function usePlaybackIntent(): PlaybackIntent {
  const [intent, setIntent] = useState<PlaybackIntent>({ playing: false });

  useEffect(() => {
    const sub = emitter.addListener("playback-intent", (payload?: { playing?: boolean }) => {
      setIntent({ playing: Boolean(payload?.playing) });
    });
    return () => sub.remove();
  }, []);

  return intent;
}

export function useStreamReady(): StreamReadyInfo | null {
  const [streamInfo, setStreamInfo] = useState<StreamReadyInfo | null>(null);

  useEffect(() => {
    const readySub = emitter.addListener("stream-ready", (payload?: { position?: number; duration?: number; isLive?: boolean }) => {
      setStreamInfo({
        position: Number(payload?.position ?? 0),
        duration: Number(payload?.duration ?? 0),
        isLive: Boolean(payload?.isLive),
      });
    });
    // Listen for stream-info updates (e.g., when duration becomes available for HLS)
    const infoSub = emitter.addListener("stream-info", (payload?: { duration?: number; isLive?: boolean }) => {
      setStreamInfo((prev) => prev ? {
        ...prev,
        duration: Number(payload?.duration ?? prev.duration),
        isLive: Boolean(payload?.isLive),
      } : null);
    });
    // Reset when playback state becomes none or stopped
    const stateSub = emitter.addListener("playback-state", (payload?: { state?: string }) => {
      if (payload?.state === "none" || payload?.state === "stopped") {
        setStreamInfo(null);
      }
    });
    return () => {
      readySub.remove();
      infoSub.remove();
      stateSub.remove();
    };
  }, []);

  return streamInfo;
}

export function useSeeking(): boolean {
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    const startSub = emitter.addListener("seek-started", () => setSeeking(true));
    const endSub = emitter.addListener("seek-completed", () => setSeeking(false));
    return () => {
      startSub.remove();
      endSub.remove();
    };
  }, []);

  return seeking;
}

const TrackPlayer = {
  registerPlaybackService,
  updateOptions,
  setupPlayer,
  add,
  play,
  pause,
  stop,
  reset,
  seekTo,
  getProgress,
  getPlaybackState,
  getActiveTrack,
  addEventListener,
};

export default TrackPlayer;
