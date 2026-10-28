/**
 * Clipboard helper at the boundary of a client-only browser API.
 *
 * This file used to cover `buildLoginRedirect`, the client-side builder for
 * `/login?next=`. The console is guest-first now: nothing redirects to `/login`, so
 * that helper is gone. The safe *deep link* it guarded still exists as
 * `buildLoginHref` and is covered in `session-gate.test.ts`.
 *
 * `CopyButton` is a client component, so it cannot be rendered without a DOM (the
 * work package may not add jsdom/testing-library); its decision logic is exported
 * and exercised here, and the component only wires it to a click.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { copyText } = await import('@/components/ui/CopyButton');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('refuses an empty value without touching the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the async clipboard API in a secure context', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { isSecureContext: true, });
    await expect(copyText('ar-0123456789abcdef0123456789abcdef')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('ar-0123456789abcdef0123456789abcdef');
  });

  it('reports a permission denial instead of throwing', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { isSecureContext: true });
    // No `document` in this environment, so the legacy path cannot run either.
    await expect(copyText('secret')).resolves.toBe(false);
  });

  it('never throws when no clipboard is available at all', async () => {
    await expect(copyText('secret')).resolves.toBe(false);
  });
});
