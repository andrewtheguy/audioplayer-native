import AVFoundation
import MediaPlayer
import React
import UIKit

@objc(HLSPlayerModule)
class HLSPlayerModule: RCTEventEmitter {
  private var player: AVPlayer?
  private var playerItem: AVPlayerItem?
  private var timeObserverToken: Any?
  
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

  // Pending start position and autoplay
  private var pendingStartPosition: Double? = nil
  private var pendingAutoplay: Bool = false
  private var hasEmittedStreamReady = false
  private var hasEmittedStreamInfo = false

  // Stream info
  private var probedIsLive: Bool = false
  private var probedDuration: Double = 0

  // Preload state
  private var isPreloading: Bool = false
  private var preloadTargetPosition: Double = 0
    
  // KVO Contexts
  private var playerItemStatusContext = 0
  private var playerTimeControlStatusContext = 0
  private var playerItemDurationContext = 0

  deinit {
    stopPositionTimer()
    seekDebounceWorkItem?.cancel()
    removePlayerObservers()
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
    resetPlayer()

    // Store pending start position and autoplay
    let startPos = startPosition?.doubleValue
    if let start = startPos, start > 0 {
      self.pendingStartPosition = start
    } else {
      self.pendingStartPosition = nil
    }
    self.pendingAutoplay = autoplay
    self.hasEmittedStreamReady = false
    self.hasEmittedStreamInfo = false

    // Create AVPlayer
    let asset = AVURLAsset(url: url)
    let item = AVPlayerItem(asset: asset)
    self.playerItem = item
    
    // Buffering configuration to reduce glitches
    item.preferredForwardBufferDuration = 30
    item.canUseNetworkResourcesForLiveStreamingWhilePaused = true
    
    self.player = AVPlayer(playerItem: item)
    self.player?.automaticallyWaitsToMinimizeStalling = true
    
    // Add Observers
    addPlayerObservers(item: item, player: self.player!)
    
    // Initial probe of duration (optional, but helpful for immediate feedback if mostly working with VOD)
    // We rely on 'status' change for the real ready state.
    
    // Preload setup
    configurePlayerStart(title: title, urlString: urlString, autoplay: autoplay, resolver: resolver)
  }

  private func configurePlayerStart(title: String?, urlString: String, autoplay: Bool, resolver: @escaping RCTPromiseResolveBlock) {
    // If pendingStartPosition, we'll seek when ready in emitStreamReady
    
    if !autoplay {
      isPreloading = true
    }
    
    // Emit initial playback-progress if we have a start position
    if let startPos = pendingStartPosition, startPos > 0 {
      lastStablePosition = startPos
      sendEvent(withName: "playback-progress", body: [
        "position": startPos,
        "duration": 0, // Unknown yet
        "seeking": false
      ])
    }

    // Now Playing info init
    nowPlayingInfo = [:]
    nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = false // Assume VOD until proven otherwise or updated
    updateNowPlaying(title: title ?? "Stream", url: urlString)

    if autoplay {
      pendingAutoplay = false
      desiredIsPlaying = true
      sendPlaybackIntent(true)
      player?.play()
      updateNowPlayingState(isPlaying: true)
      // Playback state will be updated via KVO
    } else {
        // Just prepare
        // AVPlayer doesn't strictly need a "preload" call like VLC might to open headers, creating the item is enough.
        // We just wait for ready status.
    }

    resolver(nil)
  }
    
  private func addPlayerObservers(item: AVPlayerItem, player: AVPlayer) {
      item.addObserver(self, forKeyPath: "status", options: [.new], context: &playerItemStatusContext)
      item.addObserver(self, forKeyPath: "duration", options: [.new], context: &playerItemDurationContext)
      player.addObserver(self, forKeyPath: "timeControlStatus", options: [.new], context: &playerTimeControlStatusContext)
      
      NotificationCenter.default.addObserver(self, selector: #selector(playerDidFinishPlaying), name: .AVPlayerItemDidPlayToEndTime, object: item)
      NotificationCenter.default.addObserver(self, selector: #selector(playerError), name: .AVPlayerItemFailedToPlayToEndTime, object: item)
      // Stall detection
      NotificationCenter.default.addObserver(self, selector: #selector(playerStalled), name: .AVPlayerItemPlaybackStalled, object: item)
  }
    
  private func removePlayerObservers() {
      guard let item = playerItem, let player = player else { return }
      item.removeObserver(self, forKeyPath: "status", context: &playerItemStatusContext)
      item.removeObserver(self, forKeyPath: "duration", context: &playerItemDurationContext)
      player.removeObserver(self, forKeyPath: "timeControlStatus", context: &playerTimeControlStatusContext)
      NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: item)
      NotificationCenter.default.removeObserver(self, name: .AVPlayerItemFailedToPlayToEndTime, object: item)
      NotificationCenter.default.removeObserver(self, name: .AVPlayerItemPlaybackStalled, object: item)
  }
    
  override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey : Any]?, context: UnsafeMutableRawPointer?) {
      if context == &playerItemStatusContext {
          guard let item = playerItem else { return }
          if item.status == .readyToPlay {
              // Check duration
              let duration = item.duration.seconds
              let isLive = item.duration == .indefinite || !duration.isFinite
              self.probedIsLive = isLive
              self.probedDuration = (duration.isFinite && duration > 0) ? duration : 0
              self.hasValidDuration = !isLive && self.probedDuration > 0
              
              _ = emitStreamReady()
              sendPlaybackState("ready")
          } else if item.status == .failed {
              let msg = item.error?.localizedDescription ?? "Unknown error"
              sendEvent(withName: "playback-error", body: ["message": msg])
              sendPlaybackState("stopped")
          }
      } else if context == &playerItemDurationContext {
         // Update duration if it changes (e.g. HLS loaded more)
          let duration = playerItem?.duration.seconds ?? 0
          if duration.isFinite && duration > 0 {
             self.probedDuration = duration
             self.hasValidDuration = true
             updateNowPlayingProgress()
          }
      } else if context == &playerTimeControlStatusContext {
          guard let player = player else { return }
          switch player.timeControlStatus {
          case .paused:
              sendPlaybackState("paused")
              updateNowPlayingState(isPlaying: false)
          case .playing:
              sendPlaybackState("playing")
              updateNowPlayingState(isPlaying: true)
          case .waitingToPlayAtSpecifiedRate:
              sendPlaybackState("buffering")
          @unknown default:
              break
          }
      } else {
          super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
      }
  }

  @objc private func playerDidFinishPlaying(note: NSNotification) {
      sendPlaybackState("stopped")
      sendEvent(withName: "remote-stop", body: nil) // Or just stop?
      // Native behavior for finished:
      player?.seek(to: .zero) 
      desiredIsPlaying = false
      sendPlaybackIntent(false)
      updateNowPlayingState(isPlaying: false)
  }

  @objc private func playerError(note: NSNotification) {
      // Extract error
      if let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error {
          sendEvent(withName: "playback-error", body: ["message": error.localizedDescription])
      }
  }
    
  @objc private func playerStalled(note: NSNotification) {
      sendPlaybackState("buffering")
  }
    
  private func resetPlayer() {
      removePlayerObservers()
      player?.pause()
      player = nil
      playerItem = nil
      
      stopPositionTimer()
      startPositionTimer() // Restart timer
      
      seekDebounceWorkItem?.cancel()
      seekDebounceWorkItem = nil
      
      desiredIsPlaying = false
      sendPlaybackIntent(false)
      hasValidDuration = false
      isSeeking = false
      seekTargetPosition = 0
      lastStablePosition = 0
      pendingStartPosition = nil
      pendingAutoplay = false
      hasEmittedStreamReady = false
      hasEmittedStreamInfo = false
      isPreloading = false
      preloadTargetPosition = 0
      
      nowPlayingInfo = [:]
      nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = true
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
      updateRemoteSeekAvailability(isLive: true)
      updateNowPlayingState(isPlaying: false)
      sendPlaybackState("none")
  }


  // MARK: - Core playback methods

  private func performPlay() {
    initialize()
    desiredIsPlaying = true
    sendPlaybackIntent(true)
    isPreloading = false
    
    // If ended, seek to start
    if playerItem?.currentTime() == playerItem?.duration {
         player?.seek(to: .zero)
    }

    player?.play()
  }

  private func performPause() {
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    player?.pause()
  }

  private func performStop() {
    // stopPositionTimer() // Keep timer running to avoid recreating it constantly if we reuse
    player?.pause()
    player?.seek(to: .zero)
    
    desiredIsPlaying = false
    sendPlaybackIntent(false)
    // AVPlayer doesn't truly "stop" like VLC, we just pause and reset postion.
    // We can interpret this as stopped.
    
    sendPlaybackState("stopped")
    updateNowPlayingState(isPlaying: false)
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
    resetPlayer()
    resolve(nil)
  }
    
  private func performSeek(to targetSeconds: Double) {
    guard let player = player else { return }

    let clampedTarget = max(0, targetSeconds)
    let wasAlreadySeeking = isSeeking

    seekTargetPosition = clampedTarget
    isSeeking = true

    if !wasAlreadySeeking {
      sendEvent(withName: "seek-started", body: ["targetPosition": clampedTarget])
    }

    sendEvent(withName: "playback-progress", body: [
      "position": clampedTarget,
      "duration": safeDuration(),
      "seeking": true
    ])

    updateNowPlayingProgress()

    seekDebounceWorkItem?.cancel()

    let workItem = DispatchWorkItem { [weak self] in
      guard let self = self, let player = self.player else { return }
      let targetTime = CMTime(seconds: self.seekTargetPosition, preferredTimescale: 1000)
      player.seek(to: targetTime, toleranceBefore: .zero, toleranceAfter: .zero) { finished in
          if finished {
              self.isSeeking = false
              self.sendEvent(withName: "seek-completed", body: nil)
          }
      }
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

  // MARK: - Helpers

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
    updateNowPlayingProgress()
    updateNowPlayingState(isPlaying: player?.timeControlStatus == .playing)
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

  private func emitStreamReady() -> Bool {
    guard !hasEmittedStreamReady else { return false }
    hasEmittedStreamReady = true

    let currentPos = safePosition()
    let duration = safeDuration()

    let reportedPosition: Double
    if let startPos = pendingStartPosition, startPos > 0 {
      reportedPosition = startPos
    } else {
      reportedPosition = currentPos
    }
    
    let effectiveDuration = probedDuration > 0 ? probedDuration : duration
    let effectiveIsLive = probedIsLive || (effectiveDuration <= 0 || !effectiveDuration.isFinite)

    sendEvent(withName: "stream-ready", body: [
      "position": reportedPosition,
      "duration": effectiveDuration,
      "isLive": effectiveIsLive
    ])

    updateRemoteSeekAvailability(isLive: effectiveIsLive)

    if let startPos = pendingStartPosition, startPos > 0 {
      pendingStartPosition = nil
      if abs(currentPos - startPos) > 1.0 {
        performSeek(to: startPos)
        return true
      }
    }
      
    if pendingAutoplay {
       // KVO handler will handle state update if it works, but we should make sure we command play
       player?.play()
    }
    
    return true
  }

  private func emitPeriodicPosition() {
    guard let player = player, player.timeControlStatus == .playing, !isSeeking, !isPreloading else { return }

    let position = safePosition()
    let duration = safeDuration()

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
        if strongSelf.player?.timeControlStatus == .playing {
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
    let target = current + forwardInterval // Just jump forward for next? Or use logic? Kept consistent with old code
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
    guard let time = player?.currentTime() else { return 0 }
    return time.seconds
  }

  private func effectivePosition() -> Double {
    return isSeeking ? seekTargetPosition : currentPosition()
  }

  private func currentDuration() -> Double {
    guard let duration = playerItem?.duration.seconds else { return 0 }
    return duration.isFinite ? duration : 0
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
      if hasValidDuration {
        nowPlayingInfo[MPNowPlayingInfoPropertyIsLiveStream] = false
      }
    }
    nowPlayingInfo[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue

    let position = safePosition()
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player?.rate ?? 0.0
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
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player?.rate ?? 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func sendPlaybackState(_ state: String) {
    sendEvent(withName: "playback-state", body: ["state": state])
  }

  private func sendPlaybackIntent(_ playing: Bool) {
    sendEvent(withName: "playback-intent", body: ["playing": playing])
  }
}
