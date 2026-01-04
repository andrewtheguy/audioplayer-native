import TrackPlayer, { Event } from "react-native-track-player";

const DEFAULT_FORWARD_INTERVAL = 30;
const DEFAULT_BACKWARD_INTERVAL = 15;

// TrackPlayer service should only be initialized once per app lifecycle.
// We keep listener subscriptions so we can remove them if the service is restarted
// (e.g., fast refresh or manual re-register).
let cleanupListeners: (() => void) | null = null;

// TrackPlayer expects a service handler that returns Promise<void>
export async function PlaybackService(): Promise<void> {
  // Prevent duplicate listeners when the service is invoked multiple times.
  if (cleanupListeners) {
    cleanupListeners();
  }

  const subscriptions = [
    TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play()),
    TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause()),
    TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop()),
    TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
      TrackPlayer.seekTo(event.position);
    }),
    TrackPlayer.addEventListener(Event.RemoteJumpForward, async (event) => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        await TrackPlayer.seekTo(position + (event.interval || DEFAULT_FORWARD_INTERVAL));
      } catch (error) {
        console.error("Remote jump forward failed:", error);
      }
    }),
    TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (event) => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        await TrackPlayer.seekTo(Math.max(0, position - (event.interval || DEFAULT_BACKWARD_INTERVAL)));
      } catch (error) {
        console.error("Remote jump backward failed:", error);
      }
    }),
    TrackPlayer.addEventListener(Event.RemoteNext, async () => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        await TrackPlayer.seekTo(position + DEFAULT_FORWARD_INTERVAL);
      } catch (error) {
        console.error("Remote next failed:", error);
      }
    }),
    TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        await TrackPlayer.seekTo(Math.max(0, position - DEFAULT_BACKWARD_INTERVAL));
      } catch (error) {
        console.error("Remote previous failed:", error);
      }
    }),
    TrackPlayer.addEventListener(Event.PlaybackError, (event) => {
      console.error("Playback error:", event.message);
    }),
  ];

  cleanupListeners = () => {
    subscriptions.forEach((subscription) => {
      // addEventListener returns an EmitterSubscription with remove()
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove();
      }
    });
    cleanupListeners = null;
  };
}

export function cleanupPlaybackService(): void {
  if (cleanupListeners) {
    cleanupListeners();
  }
}
