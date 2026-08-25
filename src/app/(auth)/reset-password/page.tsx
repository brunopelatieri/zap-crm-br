'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import {
  getAuthErrorMessageKey,
  getAuthErrorLogDetails,
} from '@/lib/auth/error-messages';
import {
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  passwordsMatch,
} from '@/lib/auth/password-policy';
import { PasswordStrengthMeter } from '@/components/auth/password-strength-meter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { MessageSquare, CheckCircle } from 'lucide-react';

export default function ResetPasswordPage() {
  const t = useTranslations('ResetPasswordPage');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const passwordValid = isPasswordValid(evaluatePassword(password));

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!passwordsMatch(password, confirmPassword)) {
      setError(t('passwordsMismatch'));
      return;
    }

    if (!passwordValid) {
      setError(t('errorPasswordPolicy'));
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({
      password: normalizePassword(password),
    });

    if (error) {
      console.error(
        '[reset-password] auth.updateUser failed:',
        getAuthErrorLogDetails(error)
      );
      setError(t(getAuthErrorMessageKey(error)));
      setLoading(false);
      return;
    }

    // The recovery link left the browser in a recovery session. Sign
    // out (default scope 'global', so any other live session is revoked
    // too) and make the user re-authenticate with the new password.
    // A failure here doesn't invalidate the password change, so we log
    // it and still show success rather than alarming the user.
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      console.error(
        '[reset-password] auth.signOut failed:',
        getAuthErrorLogDetails(signOutError)
      );
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <Card className="border-border bg-card w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
              <CheckCircle className="text-primary h-6 w-6" />
            </div>
            <CardTitle className="text-foreground text-xl">
              {t('successTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('successDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button className="bg-primary text-primary-foreground hover:bg-primary/90 w-full">
                {t('goToSignIn')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

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
        <CardContent>
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t('passwordLabel')}
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
              {password && <PasswordStrengthMeter password={password} />}
            </div>

            <div className="flex flex-col gap-2">
              <Label
                htmlFor="confirmPassword"
                className="text-muted-foreground"
              >
                {t('confirmPasswordLabel')}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder={t('confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={
                loading ||
                !passwordValid ||
                !passwordsMatch(password, confirmPassword)
              }
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2 h-10 w-full disabled:opacity-50"
            >
              {loading ? t('saving') : t('savePassword')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
