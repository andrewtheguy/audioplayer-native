import * as TrackPlayer from "./HlsTrackPlayer";

const DEFAULT_FORWARD_INTERVAL = 30;
const DEFAULT_BACKWARD_INTERVAL = 15;

// TrackPlayer service should only be initialized once per app lifecycle.
// We keep listener subscriptions so we can remove them if the service is restarted
// (e.g., fast refresh or manual re-register).
let cleanupListeners: (() => void) | null = null;

// TrackPlayer expects a service handler that returns Promise<void>
export async function PlaybackService(): Promise<void> {
  await TrackPlayer.updateOptions({
    forwardJumpInterval: DEFAULT_FORWARD_INTERVAL,
    backwardJumpInterval: DEFAULT_BACKWARD_INTERVAL,
  });

  // Prevent duplicate listeners when the service is invoked multiple times.
  if (cleanupListeners) {
    cleanupListeners();
  }

  const subscriptions = [
    TrackPlayer.addEventListener("remote-play", () => TrackPlayer.play()),
    TrackPlayer.addEventListener("remote-pause", () => TrackPlayer.pause()),
    TrackPlayer.addEventListener("remote-stop", () => TrackPlayer.stop()),
    TrackPlayer.addEventListener("remote-seek", (event) => {
      if (!event) return;
      TrackPlayer.seekTo(event.position ?? 0);
    }),
    TrackPlayer.addEventListener("remote-jump-forward", async (event) => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        const interval = event?.interval ?? DEFAULT_FORWARD_INTERVAL;
        await TrackPlayer.seekTo(position + interval);
      } catch (error) {
        console.error("Remote jump forward failed:", error);
      }
    }),
    TrackPlayer.addEventListener("remote-jump-backward", async (event) => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        const interval = event?.interval ?? DEFAULT_BACKWARD_INTERVAL;
        await TrackPlayer.seekTo(Math.max(0, position - interval));
      } catch (error) {
        console.error("Remote jump backward failed:", error);
      }
    }),
    // Intentionally map hardware next/previous to fixed time skips since this app is single-track.
    TrackPlayer.addEventListener("remote-next", async () => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        await TrackPlayer.seekTo(position + DEFAULT_FORWARD_INTERVAL);
      } catch (error) {
        console.error("Remote next failed:", error);
      }
    }),
    TrackPlayer.addEventListener("remote-previous", async () => {
      try {
        const position = await TrackPlayer.getProgress().then((p) => p.position);
        await TrackPlayer.seekTo(Math.max(0, position - DEFAULT_BACKWARD_INTERVAL));
      } catch (error) {
        console.error("Remote previous failed:", error);
      }
    }),
    TrackPlayer.addEventListener("playback-error", (event) => {
      if (!event) return;
      const message = typeof event.message === "string" ? event.message : "Unknown error";
      console.error("Playback error:", message);
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
