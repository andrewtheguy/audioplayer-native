import AVFoundation
import MediaPlayer
import MobileVLCKit
import React

@objc(HLSPlayerModule)
class HLSPlayerModule: RCTEventEmitter, VLCMediaPlayerDelegate {
  private var player: VLCMediaPlayer?
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

    let mediaPlayer = VLCMediaPlayer()
    mediaPlayer.delegate = self
    mediaPlayer.media = VLCMedia(url: url)

    if let start = startPosition?.doubleValue, start > 0 {
      mediaPlayer.media?.addOption(":start-time=\(start)")
    }

    player = mediaPlayer
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
    player?.stop()
    seekTo(NSNumber(value: 0), resolver: { _ in }, rejecter: { _, _, _ in })
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("stopped")
    resolve(nil)
  }

  @objc
  func reset(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    player?.stop()
    player = nil
    updateNowPlayingState(isPlaying: false)
    sendPlaybackState("none")
    resolve(nil)
  }

  @objc
  func seekTo(_ position: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let player = player else {
      resolve(nil)
      return
    }

    let millis = Int32(max(0, position.doubleValue * 1000))
    player.time = VLCTime(int: millis)
    updateNowPlayingProgress()
    resolve(nil)
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
    return 0
  }

  private func updateNowPlaying(title: String, artist: String = "", url: String = "", duration: Double? = nil) {
    nowPlayingInfo[MPMediaItemPropertyTitle] = title
    nowPlayingInfo[MPMediaItemPropertyArtist] = artist
    nowPlayingInfo["url"] = url

    if let duration = duration, duration > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
    }

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
    let mapped = mapState(state)
    sendPlaybackState(mapped)
    updateNowPlayingState(isPlaying: state == .playing)

    if state == .error {
      sendEvent(withName: "playback-error", body: ["message": "Playback failed"])
    }
  }

  func mediaPlayerTimeChanged(_ aNotification: Notification) {
    let position = safePosition()
    let duration = safeDuration()
    sendEvent(withName: "playback-progress", body: [
      "position": position,
      "duration": duration,
    ])
    updateNowPlayingProgress()
  }
}
