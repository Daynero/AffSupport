import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { FileTrigger as AriaFileTrigger } from 'react-aria-components/FileTrigger';

/**
 * The way into the file system (070, R5).
 *
 * Every "add files" in the product was a hidden `<input type="file">` beside a
 * button whose click handler reached for it through a ref — the one raw
 * control left in the explorer, and a second copy of the same three lines
 * wherever files came in. This is React Aria's `FileTrigger`: any pressable of
 * the inventory (a `Button`, an `IconButton`) opens the picker, and the input
 * it drives stays an implementation detail of this file.
 *
 * Two doors, because the product has two:
 *
 * - **A trigger.** Pass a `Button` as the child; pressing it opens the picker.
 * - **A menu item.** A `DropdownMenu` item is not a pressable this component
 *   can wrap, so the ref carries `open()`: render the trigger without a child
 *   and call `ref.current.open()` from the item's `onSelect`.
 *
 * `acceptDirectory` asks for a folder instead of files; each file then arrives
 * with its `webkitRelativePath`, which is how a folder's shape is kept. The
 * picker is reset before it opens, so choosing the same file twice in a row is
 * two choices, not one. A cancelled picker calls nothing.
 */
export type FileTriggerProps = {
  /** The files chosen, as an array; never called for an empty choice. */
  onSelect: (files: File[]) => void;
  /** A folder instead of files (`webkitdirectory`). */
  acceptDirectory?: boolean;
  /** More than one file at a time. On by default: one file is the exception. */
  allowsMultiple?: boolean;
  /** MIME types or extensions the picker offers, e.g. `['video/*', '.mov']`. */
  acceptedFileTypes?: readonly string[];
  /** The pressable that opens the picker. Omit it to open the picker through the ref. */
  children?: ReactNode;
  /**
   * The picker's name when there is no pressable to carry one: the browser's own dialog
   * announces it, and it is how an "upload into this folder" is reached at all.
   */
  label?: string;
};

/** What the ref holds: the one thing a menu item needs. */
export type FileTriggerHandle = {
  open: () => void;
};

export const FileTrigger = forwardRef<FileTriggerHandle, FileTriggerProps>(function FileTrigger(
  { onSelect, acceptDirectory = false, allowsMultiple = true, acceptedFileTypes, children, label },
  ref
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        const node = input.current;
        if (!node) return;
        // The same reset React Aria makes on a press: without it a second pick
        // of the same file fires no change and looks like a dead button.
        if (node.value) node.value = '';
        node.click();
      }
    }),
    []
  );
  const choose = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length > 0) onSelect(files);
  };
  if (children === undefined || children === null) {
    /* No pressable to wrap: React Aria's trigger would warn that its press
       responder found nobody, so the picker is the same hidden input, drawn
       here, with the attributes React Aria gives it. */
    return (
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        multiple={allowsMultiple}
        accept={acceptedFileTypes?.toString()}
        {...(acceptDirectory ? { webkitdirectory: '' } : {})}
        onChange={event => choose(event.currentTarget.files)}
      />
    );
  }
  return (
    <AriaFileTrigger
      ref={input}
      acceptDirectory={acceptDirectory}
      allowsMultiple={allowsMultiple}
      acceptedFileTypes={acceptedFileTypes}
      onSelect={choose}
    >
      {children}
    </AriaFileTrigger>
  );
});
