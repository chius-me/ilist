import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileActionSheet } from '../../src/ui/features/explorer/MobileActionSheet';

describe('responsive actions', () => {
  it('exposes the same actions in a labeled mobile dialog and closes on Escape', () => {
    const onClose = vi.fn();
    render(<MobileActionSheet open title="Actions for report.pdf" actions={[{ id: 'download', label: 'Download', onSelect: () => undefined }]} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Actions for report.pdf' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns focus to its trigger when closed', () => {
    const onClose = vi.fn();
    render(<button type="button">Actions for report.pdf</button>);
    const trigger = screen.getByRole('button', { name: 'Actions for report.pdf' });
    trigger.focus();
    const { unmount } = render(<MobileActionSheet open title="Actions for report.pdf" actions={[]} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();
  });
});
