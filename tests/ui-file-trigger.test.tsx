// @vitest-environment jsdom
import React, { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, FileTrigger, type FileTriggerHandle } from '../apps/web/src/components/ui/index';

/**
 * The inventory's way into the file system (070, R5).
 *
 * A pressable opens the picker; a menu item opens it through the ref; a folder
 * is asked for with `webkitdirectory`; the caller gets an array, and nothing
 * for a cancelled choice.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const file = (name: string) => new File(['x'], name, { type: 'video/mp4' });

function picker(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  return input;
}

describe('FileTrigger', () => {
  it('opens the picker from the button it wraps', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    render(
      <FileTrigger onSelect={() => {}}>
        <Button>Add files</Button>
      </FileTrigger>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add files' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('hands over the chosen files as an array, and nothing for an empty choice', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileTrigger onSelect={onSelect}>
        <Button>Add files</Button>
      </FileTrigger>
    );
    const input = picker(container);
    expect(input.multiple).toBe(true);
    fireEvent.change(input, { target: { files: [file('a.mp4'), file('b.mp4')] } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].map((chosen: File) => chosen.name)).toEqual([
      'a.mp4',
      'b.mp4'
    ]);
    fireEvent.change(input, { target: { files: [] } });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('asks for a folder, one file, or a kind of file when told to', () => {
    const { container, rerender } = render(
      <FileTrigger acceptDirectory onSelect={() => {}}>
        <Button>Add a folder</Button>
      </FileTrigger>
    );
    expect(picker(container).hasAttribute('webkitdirectory')).toBe(true);
    rerender(
      <FileTrigger
        allowsMultiple={false}
        acceptedFileTypes={['video/*', '.mov']}
        onSelect={() => {}}
      >
        <Button>One video</Button>
      </FileTrigger>
    );
    expect(picker(container).multiple).toBe(false);
    expect(picker(container).accept).toBe('video/*,.mov');
    expect(picker(container).hasAttribute('webkitdirectory')).toBe(false);
  });

  it('opens from a menu item through the ref, with no button of its own', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn');
    const ref = createRef<FileTriggerHandle>();
    const onSelect = vi.fn();
    const { container } = render(<FileTrigger ref={ref} acceptDirectory onSelect={onSelect} />);
    expect(screen.queryByRole('button')).toBeNull();
    const input = picker(container);
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    ref.current!.open();
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [file('c.mp4')] } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Nothing to wrap is not a misuse: React Aria's press responder must not complain.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('PressResponder'));
  });
});
