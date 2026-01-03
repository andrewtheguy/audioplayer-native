import TrackPlayer, { Event } from "react-native-track-player";

export const PlaybackService = async function () {
  // Remote control event handlers (lock screen, notification, Bluetooth)
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());

  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    TrackPlayer.seekTo(event.position);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (event) => {
    const position = await TrackPlayer.getProgress().then((p) => p.position);
    await TrackPlayer.seekTo(position + (event.interval || 30));
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (event) => {
    const position = await TrackPlayer.getProgress().then((p) => p.position);
    await TrackPlayer.seekTo(Math.max(0, position - (event.interval || 15)));
  });

  TrackPlayer.addEventListener(Event.PlaybackError, (event) => {
    console.error("Playback error:", event.message);
  });
};
