'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import {
  getAuthErrorMessageKey,
  getAuthErrorLogDetails,
} from '@/lib/auth/error-messages';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { MessageSquare } from 'lucide-react';

// This page currently only serves the password-recovery flow (SPEC 053
// §2.1.3) — every string on it is recovery-specific ("Reset password",
// "request a new password reset link"). `verifyOtp` also accepts
// signup/invite/magiclink/email_change/email tokens, but accepting those
// here would ship the wrong copy the moment one of those links is clicked.
// Migrating the other email templates to this page is tracked as
// follow-up work; do it together with per-type copy, not by loosening
// this check alone.
function isValidOtpType(value: string | null): value is 'recovery' {
  return value === 'recovery';
}

// Error codes that mean the token itself is dead — no point leaving the
// confirm button up for a retry. Everything else (rate limit, network
// blip, a still-unconfirmed account) is worth letting the user retry the
// same click before sending them back to request a brand new email.
const TERMINAL_ERROR_CODES = new Set(['otp_expired']);

// `useSearchParams` opts the component out of static prerendering unless
// it sits under a Suspense boundary — same split used by /login and
// /signup.
export default function AuthConfirmPage() {
  return (
    <Suspense fallback={null}>
      <AuthConfirmPageInner />
    </Suspense>
  );
}

function AuthConfirmPageInner() {
  const t = useTranslations('AuthConfirmPage');
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const tokenHash = searchParams.get('token_hash');
  const typeParam = searchParams.get('type');
  const next = searchParams.get('next');
  // Rejects backslashes too, not just a literal `//` prefix: WHATWG URL
  // parsing treats `/\evil.com` as protocol-relative, so `window.location.href
  // = '/\\evil.com'` navigates off-domain even though it "starts with /".
  const safeNext =
    next &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\')
      ? next
      : '/dashboard';

  const linkIsValid = Boolean(tokenHash) && isValidOtpType(typeParam);
  const isTerminalError =
    errorCode !== null && TERMINAL_ERROR_CODES.has(errorCode);
  const showConfirmButton = linkIsValid && !isTerminalError;

  // The email link points here instead of straight at Supabase's own
  // `/auth/v1/verify` so that the one-time token is only spent on a real
  // click. Automated link scanners (corporate email security, "Safe
  // Links", inbox preview prefetchers) GET this page like any other URL,
  // but that alone can't call `verifyOtp` — only this handler does, and
  // it only runs from the button's onClick. Pointing the email link
  // directly at Supabase let a scanner's prefetch burn the single-use
  // token before the real user ever clicked — see SPEC 053 §2.1.3.
  const handleConfirm = async () => {
    if (!tokenHash || !isValidOtpType(typeParam)) return;
    setError(null);
    setErrorCode(null);
    setLoading(true);

    const { data, error } = await supabase.auth.verifyOtp({
      type: typeParam,
      token_hash: tokenHash,
    });

    // A 200 with no session (e.g. the first leg of a two-step "Secure
    // email change" confirmation) isn't success for this page — it has
    // nowhere useful to send someone who isn't signed in, and the next
    // request would just get bounced off the middleware-gated `next`
    // route with no explanation.
    if (error || !data.session) {
      const details = error ? getAuthErrorLogDetails(error) : null;
      console.error('[auth/confirm] verifyOtp failed:', {
        ...details,
        hadSession: Boolean(data.session),
      });
      setErrorCode(typeof details?.code === 'string' ? details.code : null);
      setError(t(error ? getAuthErrorMessageKey(error) : 'errorGeneric'));
      setLoading(false);
      return;
    }

    // Full navigation (not router.push) so middleware sees the freshly
    // written session cookie on the very next request.
    window.location.href = safeNext;
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <MessageSquare className="text-primary h-6 w-6" />
          </div>
          <CardTitle className="text-foreground text-xl">
            {t('title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(error || !linkIsValid) && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error ?? t('errorInvalidLink')}
            </div>
          )}

          {showConfirmButton ? (
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={loading}
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-full disabled:opacity-50"
            >
              {loading ? t('confirming') : t('confirmButton')}
            </Button>
          ) : (
            <Link href="/forgot-password">
              <Button
                variant="outline"
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground w-full"
              >
                {t('requestNewLink')}
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
