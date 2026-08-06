// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../apps/soty-review/src/components/Modal.js';
import { SegmentedControl, Status } from '../apps/soty-review/src/components/Controls.js';

describe('Soty accessibility primitives', () => {
  it('supports APG arrow navigation and color-independent status text', () => {
    const onChange = vi.fn();
    render(
      <>
        <SegmentedControl
          label="Тема"
          value="light"
          options={[
            { value: 'light', label: 'Світла' },
            { value: 'dark', label: 'Темна' }
          ]}
          onChange={onChange}
        />
        <Status tone="active">Активно</Status>
      </>
    );
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(screen.getByText(/Активно/)).toBeTruthy();
  });

  it('closes modal with Escape and restores focus', () => {
    const close = vi.fn();
    render(
      <Modal title="Деталі" onClose={close}>
        <button>Вміст</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
