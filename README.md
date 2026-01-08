# audioplayer-native

A native iOS companion app to [audioplayer](https://github.com/andrewtheguy/audioplayer). Stream audio URLs and sync playback history across devices via Nostr relays. Requires initial setup on the web app—sign in here with your npub and secondary secret to access your synced history.

This native iOS app follows the architecture outlined in [audioplayer/docs/architecture.md](https://github.com/andrewtheguy/audioplayer/blob/main/docs/architecture.md). The web version of this audio player can be found in the [audioplayer repository](https://github.com/andrewtheguy/audioplayer).

## Features
- Stream audio from a URL with play/pause, seek bar, and ±15s/+30s skips.
- Volume control and time display in hh:mm:ss.
- Local history with last position and quick resume.
- Nostr-based history sync using a shared secret and session control (start/takeover/sync).
- View-only mode when another session is active.

## Requirements
- Node.js + npm
- Xcode (for iOS simulator or device builds)
- An Apple ID signed into Xcode for device signing

## Install
```bash
npm install
```

## iOS Setup
Before building for iOS, configure your development team:

```bash
cd ios
cp DevelopmentTeam.xcconfig.example DevelopmentTeam.xcconfig
```

Edit `ios/DevelopmentTeam.xcconfig` and set your Apple Development Team ID:
```
DEVELOPMENT_TEAM = YOUR_TEAM_ID_HERE
```

Find your Team ID in Xcode: Project → Signing & Capabilities → Team.

## Run on iOS
```bash
npm run ios
```

## Run on Mac (iPad on Mac / Mac Catalyst)
This uses the iOS app bundle and runs it on macOS.

1. Ensure iPad support is enabled (already in `app.json`).
2. Open the Xcode workspace:
```bash
open ios/audioplayernative.xcworkspace
```
3. In Xcode, select the app target and enable **Mac (Designed for iPad)** or **Mac Catalyst** under **Signing & Capabilities** (Xcode version dependent).
4. Choose **My Mac** as the run destination and build.

## Build a release IPA (local)
```bash
# Generates a release build using Xcode
npx expo prebuild -p ios
open ios/audioplayernative.xcworkspace
```
Then in Xcode:
- **Product > Archive**
- Distribute via Ad Hoc/TestFlight as needed.

## App flow
- Open the app and enter a 16-character secret (or generate a new one).
- Load a stream URL and optionally add a title.
- Start a sync session to push/pull history to Nostr relays.

## Notes
- The secret grants access to the synced history. Treat it like a password.
- iOS-only: `app.json` is configured for the iOS platform.
