import AVFoundation
import MediaPlayer
import MobileVLCKit
import React
import UIKit

@objc(HLSPlayerModule)
class HLSPlayerModule: RCTEventEmitter, VLCMediaPlayerDelegate {
  private var player: VLCMediaPlayer?
  private var forwardInterval: Double = 30
  private var backwardInterval: Double = 15
  private var isInitialized = false
  private var nowPlayingInfo: [String: Any] = [:]
  private var hasValidDuration = false
  private var desiredIsPlaying = false

  // Seek state tracking
  private var isSeeking = false
  private var seekTargetPosition: Double = 0
  private var lastStablePosition: Double = 0
  private var positionTimer: Timer?

  // Pending start position and autoplay (set during load, executed when stream ready)
  private var pendingStartPosition: Double? = nil
  private var pendingAutoplay: Bool = false
  private var hasEmittedStreamReady = false

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
    return [
      "remote-play",
      "remote-pause",
      "remote-stop",
      "remote-seek",
      "remote-jump-forward",
      "remote-jump-backward",
      "remote-next",
      "remote-previous",
      "playback-error",
      "playback-state",
      "playback-progress",
      "playback-intent",
      "stream-ready",
      "stream-info",
      "seek-started",
      "seek-completed",
    ]
  }

  @objc
  func initialize() {
    if isInitialized { return }
    configureAudioSession()
    configureRemoteCommands()
    configureLifecycleObservers()
    startPositionTimer()
    isInitialized = true
  }

  @objc
  func configure(_ options: NSDictionary) {
    if let forward = options["forwardInterval"] as? NSNumber {
      forwardInterval = forward.doubleValue
    }
    if let backward = options["backwardInterval"] as? NSNumber {
      backwardInterval = backward.doubleValue
    }
    configureRemoteCommands()
  }

  @objc
  func load(_ urlString: String, title: String?, startPosition: NSNumber?, autoplay: Bool, resolver: RCTPromiseResolveBlock, rejecter: RCTPromiseRejectBlock) {
    guard let url = URL(string: urlString) else {
      rejecter("invalid_url", "Invalid URL", nil)
      return
    }

    initialize()

    let mediaPlayer = VLCMediaPlayer()
    mediaPlayer.delegate = self
    mediaPlayer.media = VLCMedia(url: url)

    // Store pending start position and autoplay - will be executed when stream is ready
    if let start = startPosition?.doubleValue, start > 0 {
      pendingStartPosition = start
    } else {
      pendingStartPosition = nil
    }
    pendingAutoplay = autoplay
    hasEmittedStreamReady = false

    player = mediaPlayer
    hasValidDuration = false
    nowPlayingInfo = [:]
    // Set as live stream initially until we get valid duration from VLC
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = true
    updateNowPlaying(title: title ?? "Stream", url: urlString, duration: nil)
    resolver(nil)
  }

  @objc
  func play(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    initialize()
    desiredIsPlaying = true
    sendPlaybackIntent(true)

    // If player is in stopped/ended state, we need to seek before playing
    // VLC won't resume from an ended state without seeking first
    if let player = player, player.state == .stopped || player.state == .ended {
      let currentTime = player.time.intValue
      // If at or near the end, seek to beginning; otherwise keep current position
      let duration = player.media?.length.intValue ?? 0
      if duration > 0 && (duration - currentTime) < 1000 {
        player.time = VLCTime(int: 0)
      } else {
        player.time = VLCTime(int: currentTime)
      }
    }

    player?.play()
    updateNowPlayingState(isPlaying: true)
    updateNowPlayingProgress()
    sendPlaybackState("playing")
    resolve(nil)
  }

  @objc
  func pause(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    player?.pause()
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("paused")
    resolve(nil)
  }

  @objc
  func stop(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    if let player = player {
      player.stop()
      player.time = VLCTime(int: 0)
    }
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    hasValidDuration = false
    isSeeking = false
    seekTargetPosition = 0
    lastStablePosition = 0
    nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = nil
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = true
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("stopped")
    resolve(nil)
  }

  @objc
  func reset(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    player?.stop()
    player = nil
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    hasValidDuration = false
    isSeeking = false
    seekTargetPosition = 0
    lastStablePosition = 0
    pendingStartPosition = nil
    pendingAutoplay = false
    hasEmittedStreamReady = false
    nowPlayingInfo = [:]
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = true
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("none")
    resolve(nil)
  }

  @objc
  func seekTo(_ position: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let player = player else {
      resolve(nil)
      return
    }

    let targetSeconds = max(0, position.doubleValue)
    seekTargetPosition = targetSeconds
    isSeeking = true

    // Emit seek-started event
    sendEvent(withName: "seek-started", body: ["targetPosition": targetSeconds])

    let millis = Int32(targetSeconds * 1000)
    player.time = VLCTime(int: millis)

    // Immediately emit target position for responsive UI
    sendEvent(withName: "playback-progress", body: [
      "position": targetSeconds,
      "duration": safeDuration(),
      "seeking": true
    ])

    updateNowPlayingProgress()
    resolve(nil)
  }

  @objc
  func getProgress(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let position = safePosition()
    let duration = safeDuration()
    resolve(["position": position, "duration": duration])
  }

  @objc
  func setNowPlaying(_ options: NSDictionary) {
    let title = options["title"] as? String ?? nowPlayingInfo[MPMediaItemPropertyTitle] as? String ?? "Stream"
    let artist = options["artist"] as? String ?? nowPlayingInfo[MPMediaItemPropertyArtist] as? String ?? ""
    let url = options["url"] as? String ?? nowPlayingInfo["url"] as? String ?? ""
    let duration = options["duration"] as? NSNumber

    updateNowPlaying(title: title, artist: artist, url: url, duration: duration?.doubleValue ?? safeDuration())
  }

  private func configureAudioSession() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(
        .playback,
        mode: .default,
        policy: .longFormAudio,
        options: [.allowBluetoothA2DP, .allowAirPlay]
      )
      try audioSession.setActive(true)
    } catch {
      sendEvent(withName: "playback-error", body: ["message": "Audio session error", "detail": error.localizedDescription])
    }
  }

  private func configureLifecycleObservers() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
  }

  @objc private func handleAppForeground() {
    // Re-sync position and state when app returns from background
    updateNowPlayingProgress()
    updateNowPlayingState(isPlaying: player?.isPlaying == true)
  }

  private func startPositionTimer() {
    positionTimer?.invalidate()
    positionTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.emitPeriodicPosition()
    }
  }

  private func stopPositionTimer() {
    positionTimer?.invalidate()
    positionTimer = nil
  }

  private func emitPeriodicPosition() {
    guard let player = player, player.isPlaying, !isSeeking else { return }

    let position = safePosition()
    let duration = safeDuration()

    // Skip if position hasn't meaningfully changed
    if abs(position - lastStablePosition) < 0.1 { return }

    lastStablePosition = position
    sendEvent(withName: "playback-progress", body: [
      "position": position,
      "duration": duration,
      "seeking": false
    ])
  }

  private func configureRemoteCommands() {
    let commandCenter = MPRemoteCommandCenter.shared()

    commandCenter.playCommand.removeTarget(nil)
    commandCenter.pauseCommand.removeTarget(nil)
    commandCenter.stopCommand.removeTarget(nil)
    commandCenter.togglePlayPauseCommand.removeTarget(nil)
    commandCenter.nextTrackCommand.removeTarget(nil)
    commandCenter.previousTrackCommand.removeTarget(nil)
    commandCenter.skipForwardCommand.removeTarget(nil)
    commandCenter.skipBackwardCommand.removeTarget(nil)
    commandCenter.changePlaybackPositionCommand.removeTarget(nil)

    commandCenter.playCommand.addTarget { [weak self] _ in
      self?.handleRemotePlay()
      return .success
    }

    commandCenter.pauseCommand.addTarget { [weak self] _ in
      self?.handleRemotePause()
      return .success
    }

    commandCenter.stopCommand.addTarget { [weak self] _ in
      self?.handleRemoteStop()
      return .success
    }

    commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let strongSelf = self else { return .commandFailed }
      if strongSelf.player?.isPlaying == true {
        strongSelf.handleRemotePause()
      } else {
        strongSelf.handleRemotePlay()
      }
      return .success
    }

    commandCenter.skipForwardCommand.preferredIntervals = [NSNumber(value: forwardInterval)]
    commandCenter.skipBackwardCommand.preferredIntervals = [NSNumber(value: backwardInterval)]
    commandCenter.skipForwardCommand.isEnabled = true
    commandCenter.skipBackwardCommand.isEnabled = true
    commandCenter.changePlaybackPositionCommand.isEnabled = true

    commandCenter.skipForwardCommand.addTarget { [weak self] _ in
      self?.handleRemoteJumpForward()
      return .success
    }

    commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
      self?.handleRemoteJumpBackward()
      return .success
    }

    commandCenter.nextTrackCommand.addTarget { [weak self] _ in
      self?.handleRemoteNext()
      return .success
    }

    commandCenter.previousTrackCommand.addTarget { [weak self] _ in
      self?.handleRemotePrevious()
      return .success
    }

    commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.handleRemoteSeek(positionEvent.positionTime)
      return .success
    }
  }

  private func handleRemotePlay() {
    desiredIsPlaying = true
    sendPlaybackIntent(true)
    player?.play()
    updateNowPlayingState(isPlaying: true)
    sendPlaybackState("playing")
    sendEvent(withName: "remote-play", body: nil)
  }

  private func handleRemotePause() {
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    player?.pause()
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("paused")
    sendEvent(withName: "remote-pause", body: nil)
  }

  private func handleRemoteStop() {
    if let player = player {
      player.stop()
      player.time = VLCTime(int: 0)
    }
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    hasValidDuration = false
    nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = nil
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = true
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("stopped")
    sendEvent(withName: "remote-stop", body: nil)
  }

  private func handleRemoteJumpForward() {
    // Skip seeking disabled - emit event only for JS to handle later
    let current = currentPosition()
    sendEvent(withName: "remote-jump-forward", body: ["interval": forwardInterval, "position": current])
  }

  private func handleRemoteJumpBackward() {
    // Skip seeking disabled - emit event only for JS to handle later
    let current = currentPosition()
    sendEvent(withName: "remote-jump-backward", body: ["interval": backwardInterval, "position": current])
  }

  private func handleRemoteNext() {
    // Skip seeking disabled - emit event only for JS to handle later
    let current = currentPosition()
    sendEvent(withName: "remote-next", body: ["interval": forwardInterval, "position": current])
  }

  private func handleRemotePrevious() {
    // Skip seeking disabled - emit event only for JS to handle later
    let current = currentPosition()
    sendEvent(withName: "remote-previous", body: ["interval": backwardInterval, "position": current])
  }

  private func handleRemoteSeek(_ positionTime: TimeInterval) {
    let target = max(0, positionTime)
    seekTo(NSNumber(value: target), resolver: { _ in }, rejecter: { _, _, _ in })
    sendEvent(withName: "remote-seek", body: ["position": target])
  }

  private func currentPosition() -> Double {
    guard let time = player?.time else { return 0 }
    return Double(time.intValue) / 1000.0
  }

  private func currentDuration() -> Double {
    guard let length = player?.media?.length else { return 0 }
    let value = Double(length.intValue) / 1000.0
    return value.isFinite ? value : 0
  }

  private func safePosition() -> Double {
    let value = currentPosition()
    if value.isFinite && value >= 0 {
      return value
    }
    return 0
  }

  private func safeDuration() -> Double {
    let value = currentDuration()
    if value.isFinite && value > 0 {
      return value
    }
    // Return 0 when duration is unknown - caller should handle this
    return 0
  }

  private func updateNowPlaying(title: String, artist: String = "", url: String = "", duration: Double? = nil) {
    nowPlayingInfo[MPMediaItemPropertyTitle] = title
    nowPlayingInfo[MPMediaItemPropertyArtist] = artist
    nowPlayingInfo["url"] = url

    let resolvedDuration = duration ?? safeDuration()
    if resolvedDuration > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = resolvedDuration
      // Only mark as non-live once we have a valid duration
      if hasValidDuration {
        nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = false
      }
    }
    nowPlayingInfo[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue

    let position = safePosition()
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player?.isPlaying == true ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func updateNowPlayingState(isPlaying: Bool) {
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = safePosition()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func updateNowPlayingProgress() {
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = safePosition()
    let duration = safeDuration()
    if duration > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
    }
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player?.isPlaying == true ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func sendPlaybackState(_ state: String) {
    sendEvent(withName: "playback-state", body: ["state": state])
  }

  private func sendPlaybackIntent(_ playing: Bool) {
    sendEvent(withName: "playback-intent", body: ["playing": playing])
  }

  private func mapState(_ state: VLCMediaPlayerState) -> String {
    switch state {
    case .playing:
      return "playing"
    case .paused:
      return "paused"
    case .stopped, .ended:
      return "stopped"
    case .buffering, .opening:
      return "buffering"
    case .error:
      return "error"
    default:
      return "none"
    }
  }

  func mediaPlayerStateChanged(_ aNotification: Notification) {
    guard let state = player?.state else { return }

    // When playback naturally ends or stops, update intent to not playing
    if state == .ended || state == .stopped {
      if desiredIsPlaying {
        desiredIsPlaying = false
        sendPlaybackIntent(false)
      }
      sendPlaybackState("stopped")
      updateNowPlayingState(isPlaying: false)
      return
    }

    // If user intended pause, do not allow buffering/opening to override to "buffering".
    if desiredIsPlaying {
      var mapped = mapState(state)

      if state == .buffering || state == .opening {
        // If VLC reports buffering/opening but is actually playing, surface as playing instead of buffering
        if player?.isPlaying == true {
          mapped = "playing"
        }
      }

      sendPlaybackState(mapped)
      updateNowPlayingState(isPlaying: mapped == "playing")
    } else {
      // When paused by intent, keep reporting paused
      sendPlaybackState("paused")
      updateNowPlayingState(isPlaying: false)
    }

    if state == .error {
      sendEvent(withName: "playback-error", body: ["message": "Playback failed"])
    }
  }

  func mediaPlayerTimeChanged(_ aNotification: Notification) {
    let rawPosition = safePosition()
    let duration = safeDuration()

    // Once we get a valid duration, update Now Playing to non-live mode
    // and emit stream-info event to update isLive status
    if !hasValidDuration && duration > 0 {
      hasValidDuration = true
      nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = false
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
      // Emit stream-info to update isLive (now we know it's NOT live since we have duration)
      sendEvent(withName: "stream-info", body: [
        "duration": duration,
        "isLive": false
      ])
    }

    // Emit stream-ready once we have a valid position (stream is loaded and ready)
    if !hasEmittedStreamReady && rawPosition >= 0 {
      hasEmittedStreamReady = true
      // A stream is live if duration is not valid (0, negative, or infinite)
      let isLive = duration <= 0 || !duration.isFinite
      sendEvent(withName: "stream-ready", body: [
        "position": rawPosition,
        "duration": duration,
        "isLive": isLive
      ])

      // Handle pending start position
      if let startPos = pendingStartPosition, startPos > 0 {
        pendingStartPosition = nil
        seekTargetPosition = startPos
        isSeeking = true
        sendEvent(withName: "seek-started", body: ["targetPosition": startPos])
        let millis = Int32(startPos * 1000)
        player?.time = VLCTime(int: millis)
        sendEvent(withName: "playback-progress", body: [
          "position": startPos,
          "duration": duration,
          "seeking": true
        ])
        return
      }

      // Handle pending autoplay (if no start position to seek to)
      if pendingAutoplay {
        pendingAutoplay = false
        desiredIsPlaying = true
        sendPlaybackIntent(true)
        player?.play()
        updateNowPlayingState(isPlaying: true)
        sendPlaybackState("playing")
      }
      return
    }

    // During seeking: check if position stabilized near target
    if isSeeking {
      let tolerance: Double = 0.5
      let isNearTarget = abs(rawPosition - seekTargetPosition) < tolerance

      if isNearTarget {
        // Seek complete
        isSeeking = false
        lastStablePosition = rawPosition
        sendEvent(withName: "seek-completed", body: ["position": rawPosition])

        // Handle pending autoplay after seek completes
        if pendingAutoplay {
          pendingAutoplay = false
          desiredIsPlaying = true
          sendPlaybackIntent(true)
          player?.play()
          updateNowPlayingState(isPlaying: true)
          sendPlaybackState("playing")
        }
      } else {
        // Still seeking - emit target position for stable UI
        sendEvent(withName: "playback-progress", body: [
          "position": seekTargetPosition,
          "duration": duration,
          "seeking": true
        ])
        return
      }
    }

    lastStablePosition = rawPosition

    sendEvent(withName: "playback-progress", body: [
      "position": rawPosition,
      "duration": duration,
      "seeking": false
    ])
    updateNowPlayingProgress()
  }
}
