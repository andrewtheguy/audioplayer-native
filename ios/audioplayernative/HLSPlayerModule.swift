import AVFoundation
import MediaPlayer
import React

@objc(HLSPlayerModule)
class HLSPlayerModule: RCTEventEmitter {
  private var player: AVPlayer?
  private var timeObserver: Any?
  private var forwardInterval: Double = 30
  private var backwardInterval: Double = 15
  private var isInitialized = false
  private var nowPlayingInfo: [String: Any] = [:]

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
    ]
  }

  @objc
  func initialize() {
    if isInitialized { return }
    configureAudioSession()
    configureRemoteCommands()
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
  func load(_ urlString: String, title: String?, startPosition: NSNumber?, resolver: RCTPromiseResolveBlock, rejecter: RCTPromiseRejectBlock) {
    guard let url = URL(string: urlString) else {
      rejecter("invalid_url", "Invalid URL", nil)
      return
    }

    initialize()
    removeTimeObserver()

    let playerItem = AVPlayerItem(url: url)
    player = AVPlayer(playerItem: playerItem)
    player?.automaticallyWaitsToMinimizeStalling = true

    addTimeObserver()

    if let start = startPosition?.doubleValue, start > 0 {
      seekTo(NSNumber(value: start), resolver: { _ in }, rejecter: { _, _, _ in })
    }

    updateNowPlaying(title: title ?? "Stream", url: urlString, duration: currentDuration())
    resolver(nil)
  }

  @objc
  func play(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    initialize()
    player?.play()
    updateNowPlayingState(isPlaying: true)
    sendPlaybackState("playing")
    resolve(nil)
  }

  @objc
  func pause(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    player?.pause()
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("paused")
    resolve(nil)
  }

  @objc
  func stop(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    player?.pause()
    seekTo(NSNumber(value: 0), resolver: { _ in }, rejecter: { _, _, _ in })
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("stopped")
    resolve(nil)
  }

  @objc
  func reset(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    player?.pause()
    player = nil
    removeTimeObserver()
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("none")
    resolve(nil)
  }

  @objc
  func seekTo(_ position: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let player = player else {
      resolve(nil)
      return
    }

    let target = CMTime(seconds: position.doubleValue, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    player.seek(to: target) { _ in
      self.updateNowPlayingProgress()
      resolve(nil)
    }
  }

  @objc
  func getProgress(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let position = currentPosition()
    let duration = currentDuration()
    resolve(["position": position, "duration": duration])
  }

  @objc
  func setNowPlaying(_ options: NSDictionary) {
    let title = options["title"] as? String ?? nowPlayingInfo[MPMediaItemPropertyTitle] as? String ?? "Stream"
    let artist = options["artist"] as? String ?? nowPlayingInfo[MPMediaItemPropertyArtist] as? String ?? ""
    let url = options["url"] as? String ?? nowPlayingInfo["url"] as? String ?? ""
    let duration = options["duration"] as? NSNumber

    updateNowPlaying(title: title, artist: artist, url: url, duration: duration?.doubleValue)
  }

  private func configureAudioSession() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [.allowBluetooth, .allowAirPlay])
      try audioSession.setActive(true)
    } catch {
      sendEvent(withName: "playback-error", body: ["message": "Audio session error", "detail": error.localizedDescription])
    }
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
    player?.play()
    updateNowPlayingState(isPlaying: true)
    sendPlaybackState("playing")
    sendEvent(withName: "remote-play", body: nil)
  }

  private func handleRemotePause() {
    player?.pause()
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("paused")
    sendEvent(withName: "remote-pause", body: nil)
  }

  private func handleRemoteStop() {
    player?.pause()
    seekTo(NSNumber(value: 0), resolver: { _ in }, rejecter: { _, _, _ in })
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("stopped")
    sendEvent(withName: "remote-stop", body: nil)
  }

  private func handleRemoteJumpForward() {
    let current = currentPosition()
    let target = current + forwardInterval
    seekTo(NSNumber(value: target), resolver: { _ in }, rejecter: { _, _, _ in })
    sendEvent(withName: "remote-jump-forward", body: ["interval": forwardInterval, "position": current])
  }

  private func handleRemoteJumpBackward() {
    let current = currentPosition()
    let target = max(0, current - backwardInterval)
    seekTo(NSNumber(value: target), resolver: { _ in }, rejecter: { _, _, _ in })
    sendEvent(withName: "remote-jump-backward", body: ["interval": backwardInterval, "position": current])
  }

  private func handleRemoteNext() {
    let current = currentPosition()
    let target = current + forwardInterval
    seekTo(NSNumber(value: target), resolver: { _ in }, rejecter: { _, _, _ in })
    sendEvent(withName: "remote-next", body: ["interval": forwardInterval, "position": current])
  }

  private func handleRemotePrevious() {
    let current = currentPosition()
    let target = max(0, current - backwardInterval)
    seekTo(NSNumber(value: target), resolver: { _ in }, rejecter: { _, _, _ in })
    sendEvent(withName: "remote-previous", body: ["interval": backwardInterval, "position": current])
  }

  private func handleRemoteSeek(_ positionTime: TimeInterval) {
    let target = max(0, positionTime)
    seekTo(NSNumber(value: target), resolver: { _ in }, rejecter: { _, _, _ in })
    sendEvent(withName: "remote-seek", body: ["position": target])
  }

  private func addTimeObserver() {
    guard let player = player else { return }
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: CMTimeScale(NSEC_PER_SEC)), queue: .main) { [weak self] time in
      guard let strongSelf = self else { return }
      let position = time.seconds
      let duration = strongSelf.currentDuration()
      strongSelf.sendEvent(withName: "playback-progress", body: [
        "position": position,
        "duration": duration,
      ])
      strongSelf.updateNowPlayingProgress()
    }
  }

  private func removeTimeObserver() {
    if let observer = timeObserver, let player = player {
      player.removeTimeObserver(observer)
    }
    timeObserver = nil
  }

  private func currentPosition() -> Double {
    return player?.currentTime().seconds ?? 0
  }

  private func currentDuration() -> Double {
    guard let duration = player?.currentItem?.duration.seconds else {
      return 0
    }
    if duration.isFinite {
      return duration
    }
    return 0
  }

  private func updateNowPlaying(title: String, artist: String = "", url: String = "", duration: Double? = nil) {
    nowPlayingInfo[MPMediaItemPropertyTitle] = title
    nowPlayingInfo[MPMediaItemPropertyArtist] = artist
    nowPlayingInfo["url"] = url

    if let duration = duration, duration > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
    }

    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentPosition()
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player?.timeControlStatus == .playing ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func updateNowPlayingState(isPlaying: Bool) {
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentPosition()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func updateNowPlayingProgress() {
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentPosition()
    if currentDuration() > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = currentDuration()
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  private func sendPlaybackState(_ state: String) {
    sendEvent(withName: "playback-state", body: ["state": state])
  }

  deinit {
    removeTimeObserver()
  }
}
