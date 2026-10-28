import { fail, ok, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { getRegistrationSetting, setRegistrationEnabled } from '@/lib/settings';
import type { RegistrationSetting } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** C-SETTINGS-WIRE response body. */
interface SettingsPayload {
  registration: RegistrationSetting;
}

/** The whole addressable settings surface, read straight from the store. */
function readSettings(): SettingsPayload {
  return { registration: getRegistrationSetting() };
}

/** C-SETTINGS-WIRE: read the registration switch. `{data:{registration:{enabled}}}`. */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => ok(readSettings()));
}

/**
 * C-SETTINGS-WIRE: patch the registration switch.
 *
 * Body: `{registration:{enabled:boolean}}`. The write goes through
 * `setRegistrationEnabled`, which is the same accessor `/api/auth/register` reads
 * on every request, so the new state applies to the very next sign-up attempt -
 * no cache, no restart, no second source of truth.
 *
 * Anything that is not exactly that shape is a 400 and writes nothing: a typo in a
 * boolean must not silently close (or open) registration.
 */
export async function PATCH(request: Request): Promise<Response> {
  return withAdmin(request, async () => {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    const registration = parsed.body.registration;
    if (registration === null || typeof registration !== 'object' || Array.isArray(registration)) {
      return fail('registration must be an object: {"registration":{"enabled":true}}', 400);
    }
    const enabled = (registration as Record<string, unknown>).enabled;
    if (typeof enabled !== 'boolean') {
      return fail('registration.enabled must be a boolean', 400);
    }
    setRegistrationEnabled(enabled);
    return ok(readSettings());
  });
}
