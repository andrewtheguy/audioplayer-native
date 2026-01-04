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
};

export type PlaybackState = { state: State };

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
  | "playback-progress";

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

export async function add(track: Track): Promise<void> {
  ensureIOS();
  activeTrack = track;
  await NativeHlsPlayer.load(track.url, track.title ?? track.url, null);
  await NativeHlsPlayer.setNowPlaying({
    title: track.title ?? "Stream",
    artist: track.artist ?? "",
    url: track.url,
  });
}

export async function play(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.play();
}

export async function pause(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.pause();
}

export async function stop(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.stop();
}

export async function reset(): Promise<void> {
  ensureIOS();
  await NativeHlsPlayer.reset();
  playbackState = { state: State.None };
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
  const [state, setState] = require("react").useState<PlaybackState>(playbackState);

  require("react").useEffect(() => {
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
  const React = require("react");
  const [progress, setProgress] = React.useState<Progress>({ position: 0, duration: 0, buffered: 0 });

  React.useEffect(() => {
    const sub = emitter.addListener("playback-progress", (payload?: Progress) => {
      setProgress({
        position: Number(payload?.position ?? 0),
        duration: Number(payload?.duration ?? 0),
        buffered: Number(payload?.buffered ?? 0),
      });
    });

    const timer = setInterval(() => {
      void getProgress()
        .then((p) => setProgress(p))
        .catch(() => {
          // ignore polling failures
        });
    }, Math.max(250, updateInterval));

    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [updateInterval]);

  return progress;
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
