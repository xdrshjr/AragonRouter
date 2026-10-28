import { fail, ok } from '@/lib/api-helpers';
import { captchaDataUrl, createCaptcha } from '@/lib/captcha';
import type { CaptchaChallengePublic } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C-CAPTCHA: mint one graphical challenge.
 *
 * Answers `200 {data:{challengeId,imageDataUrl,expiresAt}}` where `imageDataUrl` is
 * `data:image/svg+xml;base64,...` (see `captchaDataUrl`). The answer never leaves the
 * server: only `sha256(challengeId:answer)` is stored, so the image is the only way to
 * read it. The challenge is single-use (5 minute TTL, at most 5 wrong attempts) and is
 * verified-and-consumed by `POST /api/auth/register` and `POST /api/auth/login`.
 *
 * No session is required: a guest needs a captcha precisely because they have no
 * session yet. Nothing here is cached (`no-store` comes from `ok()`), otherwise a
 * shared cache would hand every visitor the same challenge.
 */
export async function GET(request: Request): Promise<Response> {
  void request;
  try {
    const challenge = createCaptcha();
    const payload: CaptchaChallengePublic = {
      challengeId: challenge.id,
      imageDataUrl: captchaDataUrl(challenge.svg),
      expiresAt: challenge.expiresAt,
    };
    return ok(payload);
  } catch (error) {
    // The failure class only - never the answer, the svg or a hash.
    const reason = error instanceof Error ? error.name : 'unknown';
    console.error('[auth] unable to create a captcha challenge:', reason);
    return fail('unable to create a captcha challenge', 500);
  }
}
