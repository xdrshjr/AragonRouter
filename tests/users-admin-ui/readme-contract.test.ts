/**
 * The README contract of the user system (WP users-admin-ui, acceptance 7).
 *
 * The documentation is part of the deliverable: the role model, the endpoint table, the
 * captcha policy and the `/api/admin/session` automation exception are asserted here,
 * so the chapter cannot silently drift away from the code.
 *
 * Rework 3.1 added the second half of this file: §7.5 used to promise that a
 * non-administrator would find the registration switch "read-only" on the settings
 * page, while the shipped shell replaces *every* panel with the "administrator access
 * required" mask for a member. The prose is now asserted against the real shell, so the
 * sentence cannot drift back into a promise the product does not keep.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSnapshot } from '@/components/auth/auth-machine';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { ADMIN_REQUIRED_TITLE } from '@/components/auth/messages';
import { AuthGuard } from '@/components/console/AuthGuard';
import { SettingsPanel } from '@/components/console/SettingsPanel';
import type { UserPublic } from '@/components/console/types';
import { USER_SEARCH_DEBOUNCE_MS } from '@/components/console/users/user-copy';
import { ToastProvider } from '@/components/ui/Toast';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console/settings',
  useRouter: () => ({
    replace: () => undefined,
    refresh: () => undefined,
    push: () => undefined,
  }),
}));

const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');

/** The text of one heading block, up to the next heading of the same or a higher level. */
function sectionOf(heading: string): string {
  const start = README.indexOf(heading);
  expect(start, `README is missing ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + heading.length);
  const end = rest.search(/\n###? /);
  return end === -1 ? rest : rest.slice(0, end);
}

function account(overrides: Partial<UserPublic> = {}): UserPublic {
  return {
    id: 'user-1',
    username: 'member-one',
    displayName: 'Member One',
    role: 'member',
    status: 'active',
    createdAt: '2025-01-02T03:04:05.000Z',
    updatedAt: '2025-01-02T03:04:05.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

const MEMBER = account();
const ADMIN = account({ id: 'user-admin', username: 'admin', role: 'admin' });

/** Render the real shell around the real settings page, as a browser receives it. */
function renderSettings(state: Partial<AuthSnapshot>): string {
  const body = createElement(SettingsPanel);
  const shell = createElement(AuthGuard, { children: body });
  const provider = createElement(AuthProvider, { initialState: state, children: shell });
  return renderToStaticMarkup(createElement(ToastProvider, { children: provider }));
}

describe('README documents the user system this package ships (acceptance 7)', () => {
  it('has the user-system chapter with its role model and endpoint table', () => {
    for (const heading of [
      '## 7. 用户系统',
      '### 7.1 角色模型',
      '### 7.2 端点表',
      '### 7.3 验证码策略',
      '### 7.5 注册开关',
    ]) {
      expect(README, `README is missing ${heading}`).toContain(heading);
    }
    for (const role of ['游客', '`member`', '`admin`']) {
      expect(README, `README does not describe ${role}`).toContain(role);
    }
  });

  it('lists every account endpoint the console calls', () => {
    for (const endpoint of [
      '/api/auth/captcha',
      '/api/auth/session',
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/logout',
      '/api/auth/password',
      '/api/admin/users',
      '/api/admin/users/[id]/password',
      '/api/admin/settings',
    ]) {
      expect(README, `README has no row for ${endpoint}`).toContain(endpoint);
    }
    for (const fact of ['?limit&cursor&search&role&status', '`limit` 上限 100']) {
      expect(README, `README does not document ${fact}`).toContain(fact);
    }
  });

  it('states the captcha policy and the /api/admin/session exception', () => {
    for (const fact of ['5 分钟', '5 次', '成功即消费', '验证码']) {
      expect(README, `README does not state ${fact}`).toContain(fact);
    }
    expect(README).toContain('### 7.4 `/api/admin/session`');
    expect(README).toContain('自动化');
  });

  it('documents the numbers the panel actually uses', () => {
    expect(README).toContain(`${USER_SEARCH_DEBOUNCE_MS}ms`);
    expect(README).toContain('Load more');
    expect(README).toContain('ConfirmDialog');
    expect(README).toContain('Allow self-registration');
  });
});

/**
 * Rework 3.1 (regression): the shipped screen and the documented screen are the same.
 *
 * The defect was a documentation one - §7.5 promised "非管理员在设置页只看到当前状态（只读）"
 * while `AuthGuard`'s `ConsoleBody` masks every non-administrator, so a member never sees
 * that read-only branch. Nothing about the code was wrong (the mask is the stricter
 * behaviour and product decision #2), so the fix is the sentence, and this block keeps
 * prose and shell from parting again: the paragraph has to name the mask copy that the
 * real shell actually renders.
 */
describe('rework 3.1: §7.5 describes the screen a member really meets', () => {
  const switchSection = sectionOf('### 7.5 注册开关');

  it('names the mask instead of promising a read-only settings page', () => {
    const member = renderSettings({ status: 'authenticated', user: { ...MEMBER } });
    expect(member).toContain(ADMIN_REQUIRED_TITLE);
    expect(member).not.toContain('Allow self-registration');
    expect(member).not.toContain('read-only:');

    // The paragraph quotes the copy the shell rendered one line above.
    expect(switchSection).toContain(ADMIN_REQUIRED_TITLE);
    expect(switchSection).toContain('AuthGuard');
    // ... and it no longer makes the claim the shipped shell cannot keep.
    expect(switchSection).not.toContain('只看到当前状态');
    expect(switchSection).not.toContain('非管理员在设置页只看到');
  });

  it('still explains the read-only branch as defence in depth, not as the screen', () => {
    expect(switchSection).toContain('只读');
    expect(switchSection).toContain('SettingsPanel');
    // The panel itself still degrades read-only when it is mounted outside the shell,
    // which is exactly what the paragraph says - so the words are not merely softened.
    const bare = renderToStaticMarkup(
      createElement(ToastProvider, {
        children: createElement(AuthProvider, {
          initialState: { status: 'authenticated', user: { ...MEMBER } },
          children: createElement(SettingsPanel),
        }),
      }),
    );
    expect(bare).toContain('read-only:');
    expect(bare).not.toContain('role="switch"');
  });

  it('keeps the administrator switch documented and rendered', () => {
    const admin = renderSettings({
      status: 'authenticated',
      user: { ...ADMIN },
      registrationEnabled: true,
    });
    expect(admin).toContain('Allow self-registration');
    expect(admin).toContain('role="switch"');
    expect(switchSection).toContain('Allow self-registration');
    expect(switchSection).toContain('PATCH /api/admin/settings');
  });
});
