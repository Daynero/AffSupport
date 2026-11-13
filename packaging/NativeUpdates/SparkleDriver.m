#import "SparkleDriver.h"
#import <Sparkle/Sparkle.h>
@interface SotySparkleDriver () <SPUUpdaterDelegate, SPUUserDriver>
@property NSDictionary *candidate;
@property NSURL *feedURL;
@property(copy) SotyUpdateProgress progress;
@property SPUUpdater *updater;
@property(copy) void (^readyReply)(SPUUserUpdateChoice);
@property(copy) void (^downloadCancellation)(void);
@property uint64_t received;
@property uint64_t total;
@end
@implementation SotySparkleDriver
- (instancetype)initWithCandidate:(NSDictionary *)candidate feedURL:(NSURL *)feedURL progress:(SotyUpdateProgress)progress {
  if ((self = [super init])) { _candidate = candidate; _feedURL = feedURL; _progress = progress; }
  return self;
}
- (BOOL)startWithError:(NSError **)error {
  self.updater = [[SPUUpdater alloc] initWithHostBundle:NSBundle.mainBundle applicationBundle:NSBundle.mainBundle userDriver:self delegate:self];
  self.updater.automaticallyChecksForUpdates = NO;
  self.updater.automaticallyDownloadsUpdates = NO;
  self.updater.sendsSystemProfile = NO;
  if (![self.updater startUpdater:error]) return NO;
  [self.updater checkForUpdates];
  return YES;
}
- (BOOL)matches:(SUAppcastItem *)item {
  NSDictionary *archive = self.candidate[@"archive"];
  NSDictionary *enclosure = item.propertiesDictionary[@"enclosure"];
  return !item.isDeltaUpdate && [item.versionString isEqual:self.candidate[@"buildNumber"]] &&
    [item.fileURL.absoluteString isEqual:archive[@"url"]] && item.contentLength == [archive[@"length"] unsignedLongLongValue] &&
    [enclosure[@"sparkle:edSignature"] isKindOfClass:NSString.class] && [enclosure[@"sparkle:edSignature"] isEqual:archive[@"edSignature"]];
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feedURL.absoluteString; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
  if ([self matches:item]) return YES;
  if (error) *error = [NSError errorWithDomain:@"SotyUpdate" code:1 userInfo:@{NSLocalizedDescriptionKey:@"APP_UPDATE_CANDIDATE_CHANGED"}];
  return NO;
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  reply([self matches:item] ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceDismiss);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack { self.progress(@"failed",0,0,@"APP_UPDATE_CANDIDATE_CHANGED"); ack(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack {
  NSError *cause = error.userInfo[NSUnderlyingErrorKey] ?: error;
  NSString *code = @"APP_UPDATE_INSTALL_FAILED";
  if ([cause.domain isEqual:NSCocoaErrorDomain] && cause.code == NSFileWriteOutOfSpaceError) code = @"APP_UPDATE_DISK_FULL";
  else if ([cause.domain isEqual:NSCocoaErrorDomain] && cause.code == NSFileWriteNoPermissionError) code = @"APP_UPDATE_PERMISSION_DENIED";
  else if ([cause.domain isEqual:NSURLErrorDomain] && cause.code == NSURLErrorTimedOut) code = @"APP_UPDATE_DOWNLOAD_TIMEOUT";
  self.progress(@"failed",0,0,code); ack();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { self.downloadCancellation = cancellation; self.progress(@"install_committed",0,0,@""); }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { self.total = length; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length { self.received += length; self.progress(@"install_committed",self.received,self.total,@""); }
- (void)showDownloadDidStartExtractingUpdate { self.downloadCancellation = nil; self.progress(@"extracting",self.received,self.total,@""); }
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply { self.readyReply = reply; self.progress(@"installer_ready",self.received,self.total,@""); }
- (BOOL)cancelDownload { if (!self.downloadCancellation) return NO; void (^cancel)(void) = self.downloadCancellation; self.downloadCancellation = nil; cancel(); return YES; }
- (void)installAfterAgentExit { if (self.readyReply) { void (^reply)(SPUUserUpdateChoice) = self.readyReply; self.readyReply = nil; self.progress(@"replacement_started",self.received,self.total,@""); reply(SPUUserUpdateChoiceInstall); } }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack { ack(); }
- (void)dismissUpdateInstallation {}
- (void)updaterWillRelaunchApplication:(SPUUpdater *)updater { self.progress(@"relaunch_requested",self.received,self.total,@""); }
@end
