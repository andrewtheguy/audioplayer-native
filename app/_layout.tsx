import { PlaybackService } from "@/services/PlaybackService";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import "react-native-get-random-values";
import "react-native-reanimated";
import TrackPlayer, {
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
      Capability.SkipToNext,
      Capability.SkipToPrevious,
    ],
    compactCapabilities: [Capability.Play, Capability.Pause],
    forwardJumpInterval: 30,
    backwardJumpInterval: 15,
    // Use TrackPlayer default progress update interval
  });
}

async function teardownPlayer(): Promise<void> {
  await TrackPlayer.stop().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("TrackPlayer stop failed during teardown.", { message, error });
  });

  await TrackPlayer.reset().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("TrackPlayer reset failed during teardown.", { message, error });
  });
}

async function setupPlayer(): Promise<boolean> {
  let playbackState: Awaited<ReturnType<typeof TrackPlayer.getPlaybackState>> | null = null;

  try {
    playbackState = await TrackPlayer.getPlaybackState();
  } catch (stateError) {
    const message = stateError instanceof Error ? stateError.message : String(stateError);
    const stack = stateError instanceof Error ? stateError.stack : undefined;
    console.warn("TrackPlayer getPlaybackState failed; assuming not initialized.", {
      message,
      stack,
      error: stateError,
    });
  }

  if (playbackState?.state !== undefined) {
    try {
      await configurePlayerOptions();
      return true;
    } catch (optionsError) {
      const message = optionsError instanceof Error ? optionsError.message : String(optionsError);
      const stack = optionsError instanceof Error ? optionsError.stack : undefined;
      console.error("TrackPlayer options update failed on existing player.", {
        message,
        stack,
        error: optionsError,
      });
      // Fall through to try a fresh setup if updating options fails
    }
  }

  try {
    await teardownPlayer();

    await TrackPlayer.setupPlayer({
      iosCategory: IOSCategory.Playback,
      iosCategoryMode: IOSCategoryMode.Default,
      iosCategoryOptions: [
        IOSCategoryOptions.AllowAirPlay,
        IOSCategoryOptions.AllowBluetooth,
        IOSCategoryOptions.AllowBluetoothA2DP,
      ],
      autoHandleInterruptions: true,
      waitForBuffer: true,
      minBuffer: 120,
      maxBuffer: 300,
      playBuffer: 30,
      backBuffer: 120,
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
