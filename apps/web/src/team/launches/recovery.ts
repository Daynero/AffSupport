/** Closed diagnostic codes that can be corrected in the space's image settings. */
export function restitchSettingsError(code: string | null | undefined): boolean {
  return Boolean(
    code &&
    [
      'RESTITCH_INVALID',
      'RESTITCH_NO_SCREENS',
      'RESTITCH_POOL_EMPTY',
      'RESTITCH_SOURCES_INVALID',
      'RESTITCH_SOURCE_FORBIDDEN',
      'RESTITCH_IMAGE_UNAVAILABLE',
      'RESTITCH_LOCAL_IMAGE_MISSING',
      'RESTITCH_SCREEN_UNAVAILABLE',
      'RESTITCH_SCREEN_UNSUPPORTED'
    ].includes(code)
  );
}

/** Source incompatibility can be bypassed explicitly by keeping the original video. */
export function restitchMediaError(code: string | null | undefined): boolean {
  return Boolean(
    code &&
    [
      'UNSUPPORTED_MEDIA',
      'STITCH_PLAN_VIDEO_CODEC',
      'STITCH_PLAN_AUDIO_CODEC',
      'STITCH_PLAN_VARIABLE_FRAME_RATE',
      'STITCH_PLAN_CONTAINER'
    ].includes(code)
  );
}
