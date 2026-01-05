#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(HLSPlayerModule, RCTEventEmitter)

RCT_EXTERN_METHOD(initialize)
RCT_EXTERN_METHOD(configure:(NSDictionary *)options)
RCT_EXTERN_METHOD(load:(NSString *)urlString
                  title:(NSString *)title
          startPosition:(NSNumber *)startPosition
               autoplay:(BOOL)autoplay
                resolver:(RCTPromiseResolveBlock)resolver
                rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(play:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(pause:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(reset:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(seekTo:(NSNumber *)position resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(getProgress:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)rejecter)
RCT_EXTERN_METHOD(setNowPlaying:(NSDictionary *)options)
RCT_EXTERN_METHOD(probe:(NSString *)urlString
                resolver:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)rejecter)

@end
