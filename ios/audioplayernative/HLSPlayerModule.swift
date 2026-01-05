import AVFoundation
import MediaPlayer
import MobileVLCKit
import React
import UIKit

@objc(HLSPlayerModule)
class HLSPlayerModule: RCTEventEmitter, VLCMediaPlayerDelegate, VLCMediaDelegate {
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
  private var seekDebounceWorkItem: DispatchWorkItem?

  // Pending start position and autoplay (set during load, executed when stream ready)
  private var pendingStartPosition: Double? = nil
  private var pendingAutoplay: Bool = false
  private var hasEmittedStreamReady = false

  // Probed stream info (from AVURLAsset, fallback to VLC for unsupported formats)
  private var probedIsLive: Bool = false
  private var probedDuration: Double = 0

  // VLC probing fallback state
  private var probeMedia: VLCMedia?
  private var probeResolver: RCTPromiseResolveBlock?
  private var probeTitle: String?
  private var probeUrlString: String?
  private var probeStartPosition: Double? = nil
  private var probeAutoplay: Bool = false

  // Preload state (silent play-pause to position stream without autoplay)
  private var isPreloading: Bool = false
  private var preloadTargetPosition: Double = 0

  deinit {
    stopPositionTimer()
    seekDebounceWorkItem?.cancel()
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
  func load(_ urlString: String, title: String?, startPosition: NSNumber?, autoplay: Bool, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
    guard let url = URL(string: urlString) else {
      rejecter("invalid_url", "Invalid URL", nil)
      return
    }

    initialize()

    // Store pending start position and autoplay - will be executed when stream is ready
    let startPos = startPosition?.doubleValue
    if let start = startPos, start > 0 {
      self.pendingStartPosition = start
    } else {
      self.pendingStartPosition = nil
    }
    self.pendingAutoplay = autoplay
    self.hasEmittedStreamReady = false

    // Try AVURLAsset first (more reliable for HLS)
    let asset = AVURLAsset(url: url)
    asset.loadValuesAsynchronously(forKeys: ["duration"]) { [weak self] in
      DispatchQueue.main.async {
        guard let self = self else { return }

        var error: NSError?
        let status = asset.statusOfValue(forKey: "duration", error: &error)

        if status == .loaded {
          let durationSeconds = CMTimeGetSeconds(asset.duration)
          // A stream is live only if duration is truly indefinite (NaN/Infinite)
          self.probedIsLive = asset.duration == .indefinite || !durationSeconds.isFinite
          self.probedDuration = (durationSeconds.isFinite && durationSeconds > 0) ? durationSeconds : 0

          // AVURLAsset probe succeeded, set up VLC player
          self.setupVLCPlayer(url: url, title: title, urlString: urlString, autoplay: autoplay, resolver: resolver)
        } else {
          // AVURLAsset failed, fallback to VLC probing
          self.probeResolver = resolver
          self.probeTitle = title
          self.probeUrlString = urlString
          self.probeStartPosition = startPos
          self.probeAutoplay = autoplay

          let media = VLCMedia(url: url)
          media.delegate = self
          self.probeMedia = media
          _ = media.parse(options: .parseNetwork)
        }
      }
    }
  }

  // Helper to set up VLC player after probing completes
  private func setupVLCPlayer(url: URL, title: String?, urlString: String, autoplay: Bool, resolver: @escaping RCTPromiseResolveBlock) {
    // For live streams, don't try to restore a previous position - always start at live edge
    if probedIsLive {
      pendingStartPosition = nil
    }

    let media = VLCMedia(url: url)
    configurePlayerWithMedia(media, title: title, urlString: urlString, autoplay: autoplay, resolver: resolver)
  }

  // Shared helper for configuring player with media (used by both AVURLAsset and VLC probe paths)
  private func configurePlayerWithMedia(_ media: VLCMedia, title: String?, urlString: String, autoplay: Bool, resolver: @escaping RCTPromiseResolveBlock) {
    // pendingStartPosition is kept for emitStreamReady() to seek after stream loads
    var startPosition: Double = 0
    var needsPreload = false

    if let startPos = pendingStartPosition, startPos > 0 {
      startPosition = startPos

      // If not autoplaying, we need to do a silent preload to load the stream
      needsPreload = !autoplay
      if needsPreload {
        isPreloading = true
        preloadTargetPosition = startPos
      }
    }

    // Emit playback-progress immediately so UI shows the correct initial position
    // (stream-ready will be emitted by emitStreamReady() when VLC reports valid position,
    // which will then seek to pendingStartPosition)
    if startPosition > 0 {
      lastStablePosition = startPosition
      sendEvent(withName: "playback-progress", body: [
        "position": startPosition,
        "duration": probedDuration,
        "seeking": false
      ])
    }

    let mediaPlayer = VLCMediaPlayer()
    mediaPlayer.delegate = self
    mediaPlayer.media = media

    player = mediaPlayer
    hasValidDuration = !probedIsLive && probedDuration > 0
    nowPlayingInfo = [:]
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = probedIsLive
    if probedDuration > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = probedDuration
    }
    updateNowPlaying(title: title ?? "Stream", url: urlString, duration: probedDuration > 0 ? probedDuration : nil)

    // Handle autoplay or preload
    if autoplay {
      pendingAutoplay = false
      desiredIsPlaying = true
      sendPlaybackIntent(true)
      mediaPlayer.play()
      updateNowPlayingState(isPlaying: true)
      sendPlaybackState("playing")
    } else if needsPreload {
      // Silent preload: mute audio, play briefly to trigger start-time positioning, then pause
      mediaPlayer.audio?.isMuted = true
      mediaPlayer.play()
      mediaPlayer.pause()
      // isPreloading remains true to suppress position events until user plays
      // Keep muted - will unmute when user explicitly plays
    }

    resolver(nil)
  }

  // VLCMediaDelegate - called when VLC media parsing completes (fallback path)
  func mediaDidFinishParsing(_ aMedia: VLCMedia) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }

      // Get duration from parsed media
      let lengthMs = aMedia.length.intValue
      let durationSeconds = Double(lengthMs) / 1000.0

      // A stream is live only if duration is 0, negative, or invalid
      self.probedIsLive = lengthMs <= 0 || !durationSeconds.isFinite
      self.probedDuration = (durationSeconds.isFinite && durationSeconds > 0) ? durationSeconds : 0

      // Restore pending state from probe context
      // For live streams, don't try to restore a previous position - always start at live edge
      if !self.probedIsLive, let startPos = self.probeStartPosition, startPos > 0 {
        self.pendingStartPosition = startPos
      } else {
        self.pendingStartPosition = nil
      }
      self.pendingAutoplay = self.probeAutoplay

      // Set up VLC player with the parsed media
      guard let resolver = self.probeResolver,
            let urlString = self.probeUrlString else { return }

      let title = self.probeTitle

      // Clean up probe state before calling helper
      self.probeMedia = nil
      self.probeResolver = nil
      self.probeTitle = nil
      self.probeUrlString = nil
      self.probeStartPosition = nil
      self.probeAutoplay = false

      self.configurePlayerWithMedia(aMedia, title: title, urlString: urlString, autoplay: self.pendingAutoplay, resolver: resolver)
    }
  }

  // MARK: - Core playback methods (shared by @objc and remote handlers)

  private func performPlay() {
    initialize()
    desiredIsPlaying = true
    sendPlaybackIntent(true)

    // Unmute audio if it was muted during preload
    if let audio = player?.audio, audio.isMuted {
      audio.isMuted = false
    }

    // Clear preloading state if still set
    isPreloading = false

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
  }

  private func performPause() {
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    player?.pause()
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("paused")
  }

  private func performStop() {
    stopPositionTimer()
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
    updateRemoteSeekAvailability(isLive: true)
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("stopped")
  }

  // MARK: - React Native exposed methods

  @objc
  func play(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    performPlay()
    resolve(nil)
  }

  @objc
  func pause(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    performPause()
    resolve(nil)
  }

  @objc
  func stop(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    performStop()
    resolve(nil)
  }

  @objc
  func reset(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    stopPositionTimer()
    seekDebounceWorkItem?.cancel()
    seekDebounceWorkItem = nil
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
    isPreloading = false
    preloadTargetPosition = 0
    nowPlayingInfo = [:]
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = true
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    updateRemoteSeekAvailability(isLive: true)
    updateNowPlayingState(isPlaying: false)
    updateNowPlayingProgress()
    sendPlaybackState("none")
    resolve(nil)
  }

  /// Core seek implementation shared by seekTo() and remote jump handlers.
  /// Handles seek coalescing and debouncing: rapid seeks are coalesced and the actual VLC seek
  /// is debounced to prevent crashes from rapid time changes.
  private func performSeek(to targetSeconds: Double) {
    guard player != nil else { return }

    let clampedTarget = max(0, targetSeconds)
    let wasAlreadySeeking = isSeeking

    seekTargetPosition = clampedTarget
    isSeeking = true

    // Only emit seek-started for new seeks, not coalesced updates
    if !wasAlreadySeeking {
      sendEvent(withName: "seek-started", body: ["targetPosition": clampedTarget])
    }

    // Immediately emit target position for responsive UI
    sendEvent(withName: "playback-progress", body: [
      "position": clampedTarget,
      "duration": safeDuration(),
      "seeking": true
    ])

    updateNowPlayingProgress()

    // Debounce the actual VLC seek to prevent crashes from rapid seeks
    seekDebounceWorkItem?.cancel()

    let workItem = DispatchWorkItem { [weak self] in
      guard let self = self, let player = self.player else { return }
      let millis = Int32(self.seekTargetPosition * 1000)
      player.time = VLCTime(int: millis)
    }
    seekDebounceWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: workItem)
  }

  @objc
  func seekTo(_ position: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    performSeek(to: position.doubleValue)
    resolve(nil)
  }

  @objc
  func jumpForward(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let current = effectivePosition()
    let duration = safeDuration()
    let target = duration > 0 ? min(current + forwardInterval, duration) : current + forwardInterval
    performSeek(to: target)
    resolve(nil)
  }

  @objc
  func jumpBackward(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let current = effectivePosition()
    let target = max(0, current - backwardInterval)
    performSeek(to: target)
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

  // MARK: - Stream Ready Emission (single point of emission)

  /// Emits "stream-ready" event if not already emitted. This is the sole emission point for stream-ready.
  /// Handles: hasEmittedStreamReady guard, pendingStartPosition (manual seek if VLC start-time didn't position),
  /// seekTargetPosition, and pendingAutoplay.
  /// - Returns: true if this was the first emission (caller should return early), false if already emitted.
  private func emitStreamReady() -> Bool {
    guard !hasEmittedStreamReady else { return false }
    hasEmittedStreamReady = true

    let currentPos = safePosition()
    let duration = safeDuration()

    // Use pending start position for reported value if set, otherwise current position
    let reportedPosition: Double
    if let startPos = pendingStartPosition, startPos > 0 {
      reportedPosition = startPos
    } else {
      reportedPosition = currentPos
    }
    let effectiveDuration = probedDuration > 0 ? probedDuration : duration
    // Treat stream as live if we probed it as live, even if a sliding-window duration later appears.
    let effectiveIsLive = probedIsLive || effectiveDuration <= 0 || !effectiveDuration.isFinite

    sendEvent(withName: "stream-ready", body: [
      "position": reportedPosition,
      "duration": effectiveDuration,
      "isLive": effectiveIsLive
    ])

    updateRemoteSeekAvailability(isLive: effectiveIsLive)

    // If pending start position exists and VLC hasn't positioned there yet, perform manual seek
    if let startPos = pendingStartPosition, startPos > 0 {
      pendingStartPosition = nil

      // Only seek if current position differs significantly from target (start-time option may have worked)
      if abs(currentPos - startPos) > 1.0 {
        seekTargetPosition = startPos
        isSeeking = true
        sendEvent(withName: "seek-started", body: ["targetPosition": startPos])
        player?.time = VLCTime(int: Int32(startPos * 1000))
        sendEvent(withName: "playback-progress", body: [
          "position": startPos,
          "duration": effectiveDuration,
          "seeking": true
        ])
        return true
      }
    }

    // Handle pending autoplay
    if pendingAutoplay {
      pendingAutoplay = false
      desiredIsPlaying = true
      sendPlaybackIntent(true)
      player?.play()
      updateNowPlayingState(isPlaying: true)
      sendPlaybackState("playing")
    }

    return true
  }

  private func emitPeriodicPosition() {
    guard let player = player, player.isPlaying, !isSeeking, !isPreloading else { return }

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
    updateRemoteSeekAvailability(isLive: isLiveStream())

    commandCenter.skipForwardCommand.addTarget { [weak self] _ in
      guard let self = self, !self.isLiveStream() else { return .commandFailed }
      self.handleRemoteJumpForward()
      return .success
    }

    commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
      guard let self = self, !self.isLiveStream() else { return .commandFailed }
      self.handleRemoteJumpBackward()
      return .success
    }

    commandCenter.nextTrackCommand.addTarget { [weak self] _ in
      guard let self = self, !self.isLiveStream() else { return .commandFailed }
      self.handleRemoteNext()
      return .success
    }

    commandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let self = self, !self.isLiveStream() else { return .commandFailed }
      self.handleRemotePrevious()
      return .success
    }

    commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard
        let self = self,
        !self.isLiveStream(),
        let positionEvent = event as? MPChangePlaybackPositionCommandEvent
      else { return .commandFailed }
      self.handleRemoteSeek(positionEvent.positionTime)
      return .success
    }
  }

  private func handleRemotePlay() {
    performPlay()
    sendEvent(withName: "remote-play", body: nil)
  }

  private func handleRemotePause() {
    performPause()
    sendEvent(withName: "remote-pause", body: nil)
  }

  private func handleRemoteStop() {
    performStop()
    sendEvent(withName: "remote-stop", body: nil)
  }

  private func handleRemoteJumpForward() {
    guard !isLiveStream() else { return }
    let current = effectivePosition()
    let duration = safeDuration()
    let target = duration > 0 ? min(current + forwardInterval, duration) : current + forwardInterval
    performSeek(to: target)
    sendEvent(withName: "remote-jump-forward", body: ["interval": forwardInterval, "position": current])
  }

  private func handleRemoteJumpBackward() {
    guard !isLiveStream() else { return }
    let current = effectivePosition()
    let target = max(0, current - backwardInterval)
    performSeek(to: target)
    sendEvent(withName: "remote-jump-backward", body: ["interval": backwardInterval, "position": current])
  }

  private func handleRemoteNext() {
    guard !isLiveStream() else { return }
    let current = effectivePosition()
    let duration = safeDuration()
    let target = duration > 0 ? min(current + forwardInterval, duration) : current + forwardInterval
    performSeek(to: target)
    sendEvent(withName: "remote-next", body: ["interval": forwardInterval, "position": current])
  }

  private func handleRemotePrevious() {
    guard !isLiveStream() else { return }
    let current = effectivePosition()
    let target = max(0, current - backwardInterval)
    performSeek(to: target)
    sendEvent(withName: "remote-previous", body: ["interval": backwardInterval, "position": current])
  }

  private func handleRemoteSeek(_ positionTime: TimeInterval) {
    guard !isLiveStream() else { return }
    let target = max(0, positionTime)
    performSeek(to: target)
    sendEvent(withName: "remote-seek", body: ["position": target])
  }

  private func currentPosition() -> Double {
    guard let time = player?.time else { return 0 }
    return Double(time.intValue) / 1000.0
  }

  /// Returns seekTargetPosition if a seek is in progress, otherwise currentPosition().
  /// Use this for jump calculations to support rapid consecutive jumps.
  private func effectivePosition() -> Double {
    return isSeeking ? seekTargetPosition : currentPosition()
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

  private func isLiveStream() -> Bool {
    if probedIsLive { return true }
    if hasValidDuration { return false }
    let duration = safeDuration()
    return duration <= 0 || !duration.isFinite
  }

  private func updateRemoteSeekAvailability(isLive: Bool) {
    let commandCenter = MPRemoteCommandCenter.shared()
    let enabled = !isLive
    commandCenter.skipForwardCommand.isEnabled = enabled
    commandCenter.skipBackwardCommand.isEnabled = enabled
    commandCenter.changePlaybackPositionCommand.isEnabled = enabled
    commandCenter.nextTrackCommand.isEnabled = enabled
    commandCenter.previousTrackCommand.isEnabled = enabled
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
    // During preload, suppress all position events to keep showing the target position
    if isPreloading {
      return
    }

    let rawPosition = safePosition()
    let duration = safeDuration()

    // Once we get a valid duration, update Now Playing to non-live mode
    // and emit stream-info event to update isLive status
    if !hasValidDuration && duration > 0 {
      if probedIsLive {
        // Live HLS streams may expose a sliding-window duration; keep live semantics intact.
        sendEvent(withName: "stream-info", body: [
          "duration": duration,
          "isLive": true
        ])
        updateRemoteSeekAvailability(isLive: true)
      } else {
        hasValidDuration = true
        nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = false
        nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
        sendEvent(withName: "stream-info", body: [
          "duration": duration,
          "isLive": false
        ])
        updateRemoteSeekAvailability(isLive: false)
      }
    }

    // Emit stream-ready via centralized helper (handles hasEmittedStreamReady guard,
    // pendingStartPosition verification/seek, and pendingAutoplay)
    if emitStreamReady() {
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
