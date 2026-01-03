import TrackPlayer, { Event } from "react-native-track-player";

export const PlaybackService = function () {
  // Remote control event handlers (lock screen, notification, Bluetooth)
  const playListener = TrackPlayer.addEventListener(Event.RemotePlay, () =>
    TrackPlayer.play()
  );
  const pauseListener = TrackPlayer.addEventListener(Event.RemotePause, () =>
    TrackPlayer.pause()
  );
  const stopListener = TrackPlayer.addEventListener(Event.RemoteStop, () =>
    TrackPlayer.stop()
  );

  const seekListener = TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    TrackPlayer.seekTo(event.position);
  });

  const jumpForwardListener = TrackPlayer.addEventListener(
    Event.RemoteJumpForward,
    async (event) => {
    try {
      const position = await TrackPlayer.getProgress().then((p) => p.position);
      await TrackPlayer.seekTo(position + (event.interval || 30));
    } catch (error) {
      console.error("Remote jump forward failed:", error);
    }
    }
  );

  const jumpBackwardListener = TrackPlayer.addEventListener(
    Event.RemoteJumpBackward,
    async (event) => {
    try {
      const position = await TrackPlayer.getProgress().then((p) => p.position);
      await TrackPlayer.seekTo(Math.max(0, position - (event.interval || 15)));
    } catch (error) {
      console.error("Remote jump backward failed:", error);
    }
    }
  );

  const errorListener = TrackPlayer.addEventListener(Event.PlaybackError, (event) => {
    console.error("Playback error:", event.message);
  });

  return () => {
    playListener.remove();
    pauseListener.remove();
    stopListener.remove();
    seekListener.remove();
    jumpForwardListener.remove();
    jumpBackwardListener.remove();
    errorListener.remove();
  };
};
