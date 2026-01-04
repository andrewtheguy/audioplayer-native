import TrackPlayer, { Event } from "react-native-track-player";

// TrackPlayer expects a service handler that returns Promise<void>
export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());

  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    TrackPlayer.seekTo(event.position);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (event) => {
    try {
      const position = await TrackPlayer.getProgress().then((p) => p.position);
      await TrackPlayer.seekTo(position + (event.interval || 30));
    } catch (error) {
      console.error("Remote jump forward failed:", error);
    }
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (event) => {
    try {
      const position = await TrackPlayer.getProgress().then((p) => p.position);
      await TrackPlayer.seekTo(Math.max(0, position - (event.interval || 15)));
    } catch (error) {
      console.error("Remote jump backward failed:", error);
    }
  });

  TrackPlayer.addEventListener(Event.PlaybackError, (event) => {
    console.error("Playback error:", event.message);
  });
}
