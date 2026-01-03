# audioplayer-native

A focused iOS audio player built with Expo. Stream audio URLs, keep a local listening history, and optionally sync history across devices using a 16-character secret over Nostr relays.

## Features
- Stream audio from a URL with play/pause and ±15s seek.
- Keeps a local history with last position and quick resume.
- Nostr-based history sync using a shared secret and session control (start/takeover/sync).
- View-only mode when another session is active.

## Requirements
- Node.js + npm
- Xcode (for iOS simulator) or a physical iOS device

## Run
```bash
npm install
npx expo start --ios
```

## App flow
- Open the app and enter a 16-character secret (or generate a new one).
- Load a stream URL and optionally add a title.
- Start a sync session to push/pull history to Nostr relays.

## Notes
- The secret grants access to the synced history. Treat it like a password.
- iOS-only: `app.json` is configured for the iOS platform.
