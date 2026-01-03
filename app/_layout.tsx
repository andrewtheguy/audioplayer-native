import "react-native-get-random-values";
import "react-native-reanimated";
import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import TrackPlayer, {
  AndroidAudioContentType,
  Capability,
  IOSCategory,
  IOSCategoryMode,
  IOSCategoryOptions,
} from "react-native-track-player";
import { PlaybackService } from "@/services/PlaybackService";

// Register the playback service (must be done at module level)
TrackPlayer.registerPlaybackService(() => PlaybackService);

async function setupPlayer() {
  try {
    await TrackPlayer.setupPlayer({
      iosCategory: IOSCategory.Playback,
      iosCategoryMode: IOSCategoryMode.Default,
      iosCategoryOptions: [
        IOSCategoryOptions.AllowAirPlay,
        IOSCategoryOptions.AllowBluetooth,
        IOSCategoryOptions.AllowBluetoothA2DP,
      ],
      androidAudioContentType: AndroidAudioContentType.Music,
      autoHandleInterruptions: true,
      waitForBuffer: true,
      // Buffer configuration to reduce jitter
      minBuffer: 30, // 30 seconds minimum buffer
      maxBuffer: 120, // 2 minutes max buffer
      playBuffer: 5, // Start playback after 5 seconds buffered
      backBuffer: 30, // Keep 30 seconds behind current position
    });

    await TrackPlayer.updateOptions({
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.JumpForward,
        Capability.JumpBackward,
      ],
      compactCapabilities: [Capability.Play, Capability.Pause],
      forwardJumpInterval: 30,
      backwardJumpInterval: 15,
      progressUpdateEventInterval: 1, // Update every 1 second (reduces CPU usage)
    });
  } catch (error) {
    // Player might already be initialized
    console.log("Player setup error (may already be initialized):", error);
  }
}

export default function RootLayout() {
  const [isPlayerReady, setIsPlayerReady] = useState(false);

  useEffect(() => {
    setupPlayer().then(() => setIsPlayerReady(true));
  }, []);

  if (!isPlayerReady) {
    return null;
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="player" />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}
