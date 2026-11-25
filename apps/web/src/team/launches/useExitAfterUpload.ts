import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A way out of the launch editor asked for while a creative uploads (the close button,
 * a click beside the dialog, Escape, another tab). Closing then would unmount the picker
 * and drop the upload's result, so the exit waits for the upload and is then asked for
 * again, through the ordinary save-and-leave path, with the creative in the draft.
 *
 * Not an input lock: locking the picker revokes the very upload this waits for. A reload
 * cannot wait, so while an upload runs the page asks before it unloads.
 */
export function useExitAfterUpload(
  uploading: boolean,
  requestExit: (leave: () => void) => void
): (leave: () => void) => void {
  const [waiting, setWaiting] = useState<(() => void) | null>(null);
  const request = useRef(requestExit);
  request.current = requestExit;
  useEffect(() => {
    if (!waiting || uploading) return;
    setWaiting(null);
    request.current(waiting);
  }, [waiting, uploading]);
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);
  return useCallback((leave: () => void) => setWaiting(() => leave), []);
}
