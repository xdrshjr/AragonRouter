/**
 * Regression tests for REQUIRED CHANGE #2 of the console-ui rework.
 *
 * Defect: the login form's docblock promised that a wrong password is "announced
 * with role=\"alert\"", but the message was rendered by `ui/Input`'s `Field` as a
 * plain `<p id=...-error>` - it only reached assistive technology through
 * `aria-describedby` when focus returned to the field. The promise and the
 * implementation disagreed.
 *
 * The fix makes the promise true: `Field` renders the message as an assertive live
 * region (`role="alert"`), keeps the `id`/`aria-describedby` binding, and only
 * renders it while there is an error (so nothing is announced on first paint).
 *
 * The form moved on since (username + password + captcha, shared by the dialog and
 * `/login`) but the contract did not: every field-level failure still reaches the
 * announced live region through `Field`. The rendered assertions below use
 * `react-dom/server` (no DOM is available and the work package may not add
 * jsdom/testing-library); the interaction that creates the error state is covered
 * by the `Field` contract itself, which is what the form consumes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  usePathname: () => '/login',
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import { Field, Input } from '@/components/ui/Input';
import { LoginForm } from '@/app/login/LoginForm';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

const WRONG_PASSWORD = 'That username and password combination was not recognised.';

/** The exact composition the shared form uses for its password field. */
function passwordField(error: string | null): string {
  return renderToStaticMarkup(
    <Field label="Password" error={error} required>
      {({ id, describedBy }) => (
        <Input
          id={id}
          name="password"
          type="password"
          value=""
          onChange={() => undefined}
          invalid={error !== null}
          aria-describedby={describedBy}
        />
      )}
    </Field>,
  );
}

describe('Field error is a real live region', () => {
  it('announces the message with role="alert" as soon as it appears', () => {
    const markup = passwordField(WRONG_PASSWORD);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(WRONG_PASSWORD);
    // Assertive by default for role="alert", but spelled out where it matters:
    // the element is not merely described, it is announced.
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*class="[^"]*text-danger/);
  });

  it('keeps the message bound to the input through aria-describedby', () => {
    const markup = passwordField(WRONG_PASSWORD);

    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    expect(describedBy).toBeDefined();
    // The referenced id is the live region itself.
    expect(markup).toMatch(new RegExp(`id="${describedBy}"[^>]*role="alert"`));
    // ...and the field is flagged invalid at the same time.
    expect(markup).toContain('aria-invalid="true"');
  });

  it('renders no live region at all when there is no error', () => {
    const markup = passwordField(null);

    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('aria-invalid');
    expect(markup).not.toContain('aria-describedby');
  });

  it('the login form itself ships no alert region until a failure happens', () => {
    const markup = renderToStaticMarkup(<LoginForm nextPath="/console" />);

    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('role="alert"');
  });

  it('the shared form binds every message to its field through the kit', () => {
    const form = read('components/auth/AuthForm.tsx');
    // Field-level failures: bound to the control via the Field render prop...
    expect(form).toMatch(/<Field label=\{USERNAME_LABEL\} error=\{errors\.username\}/);
    expect(form).toMatch(/<Field\s+label=\{PASSWORD_LABEL\}\s+error=\{errors\.password\}/);
    expect(form).toContain('invalid={errors.username !== null}');
    expect(form).toContain('invalid={errors.password !== null}');
    expect(form).toContain('aria-describedby={describedBy}');
    // ...and a form-level failure is an announced live region of its own.
    expect(form).toContain('role="alert"');
    expect(form).toContain('{errors.form}');
  });

  it('the captcha field reports its own failure the same way', () => {
    const field = read('components/auth/CaptchaField.tsx');
    expect(field).toContain('<Field label={CAPTCHA_LABEL} error={message}');
    expect(field).toContain('aria-describedby={describedBy}');
    expect(field).toContain('invalid={message !== null}');
  });

  it('every other failure paragraph in the kit is announced too', () => {
    // Modal/ConfirmDialog (mutation failures, including the revoke 401) use the
    // same pattern, so the fix is consistent across the console.
    expect(read('components/ui/Modal.tsx')).toMatch(/<p role="alert"/);
  });
});
