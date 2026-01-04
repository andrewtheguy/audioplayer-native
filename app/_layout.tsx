import { PlaybackService } from "@/services/PlaybackService";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import "react-native-get-random-values";
import "react-native-reanimated";
import TrackPlayer, {
    AndroidAudioContentType,
    Capability,
    IOSCategory,
    IOSCategoryMode,
    IOSCategoryOptions,
} from "react-native-track-player";

// Register the playback service (must be done at module level)
TrackPlayer.registerPlaybackService(() => PlaybackService);

function isAlreadyInitializedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (!("message" in error)) return false;
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return message.includes("already") && (message.includes("initialized") || message.includes("setup"));
}

async function configurePlayerOptions(): Promise<void> {
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
}

async function setupPlayer(): Promise<boolean> {
  try {
    const existingState = await TrackPlayer.getState().catch(() => null);
    if (existingState !== null) {
      await configurePlayerOptions();
      return true;
    }

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
      minBuffer: 15, // 15 seconds minimum buffer
      maxBuffer: 300, // 5 minutes max buffer
      playBuffer: 2.5, // Start playback after 2.5 seconds buffered
      backBuffer: 30, // Keep 30 seconds behind current position
    });
    await configurePlayerOptions();
    return true;
  } catch (error) {
    if (isAlreadyInitializedError(error)) {
      try {
        await configurePlayerOptions();
        return true;
      } catch (optionsError) {
        const message = optionsError instanceof Error ? optionsError.message : String(optionsError);
        const stack = optionsError instanceof Error ? optionsError.stack : undefined;
        console.error("TrackPlayer setup failed.", { message, stack, error: optionsError });
        return false;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("TrackPlayer setup failed.", { message, stack, error });
    return false;
  }
}

export default function RootLayout() {
  const [isPlayerReady, setIsPlayerReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    setupPlayer()
      .then((ok) => {
        if (ok && mounted) {
          setIsPlayerReady(true);
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        console.error("TrackPlayer setup failed.", { message, stack, error });
      });

    return () => {
      mounted = false;
    };
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
