#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
typedef void (^SotyUpdateProgress)(NSString *stage, uint64_t received, uint64_t total, NSString *code);
@interface SotySparkleDriver : NSObject
- (instancetype)initWithCandidate:(NSDictionary<NSString *, id> *)candidate feedURL:(NSURL *)feedURL progress:(SotyUpdateProgress)progress NS_SWIFT_NAME(init(candidate:feedURL:progress:));
- (BOOL)startWithError:(NSError **)error NS_SWIFT_NAME(start());
- (void)installAfterAgentExit;
- (BOOL)cancelDownload;
@end
NS_ASSUME_NONNULL_END
