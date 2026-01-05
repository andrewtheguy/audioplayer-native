import * as TrackPlayer from "@/services/HlsTrackPlayer";
import { PlaybackService } from "@/services/PlaybackService";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import "react-native-get-random-values";
import "react-native-reanimated";

// Register the playback service (must be done at module level)
TrackPlayer.registerPlaybackService(PlaybackService);

async function setupPlayer(): Promise<boolean> {
  try {
    await TrackPlayer.setupPlayer();
    await TrackPlayer.updateOptions({
      forwardJumpInterval: 30,
      backwardJumpInterval: 15,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("HLS player setup failed.", { message, stack, error });
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
