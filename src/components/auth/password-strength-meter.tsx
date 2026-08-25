'use client';

import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import {
  evaluatePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARS,
} from '@/lib/auth/password-policy';

interface PasswordStrengthMeterProps {
  password: string;
}

interface RuleRow {
  id: string;
  passed: boolean;
  label: string;
}

// Live checklist + progress bar for the password rules in
// src/lib/auth/password-policy.ts — see docs/spec-054-senha-forte.md.
// `maxBytes` and `noControlChars` aren't listed as checklist rows: they're
// edge cases (a very long password, a stray control character from a
// paste), not something to encourage users to chase, so they only show up
// as dedicated warnings when actually violated. Both must still render
// something when violated — `isPasswordValid` requires all 7 rules, so a
// violation the UI never mentions disables the submit button with no way
// for the user to tell why.
export function PasswordStrengthMeter({
  password,
}: PasswordStrengthMeterProps) {
  const t = useTranslations('PasswordPolicy');
  const result = evaluatePassword(password);

  const rules: RuleRow[] = [
    {
      id: 'minLength',
      passed: result.minLength,
      label: t('ruleMinLength', { min: PASSWORD_MIN_LENGTH }),
    },
    {
      id: 'uppercase',
      passed: result.hasUppercase,
      label: t('ruleUppercase'),
    },
    {
      id: 'lowercase',
      passed: result.hasLowercase,
      label: t('ruleLowercase'),
    },
    { id: 'number', passed: result.hasNumber, label: t('ruleNumber') },
    {
      id: 'specialChar',
      passed: result.hasSpecialChar,
      label: t('ruleSpecialChar', { chars: PASSWORD_SPECIAL_CHARS }),
    },
  ];

  const passedCount = rules.filter((rule) => rule.passed).length;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={passedCount}
        aria-valuemin={0}
        aria-valuemax={rules.length}
        aria-label={t('strengthLabel')}
      >
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${(passedCount / rules.length) * 100}%` }}
        />
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {rules.map((rule) => (
          <li
            key={rule.id}
            className={`flex items-center gap-1.5 ${
              rule.passed
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
            }`}
          >
            {rule.passed ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {rule.label}
          </li>
        ))}
      </ul>
      {!result.maxBytes && (
        <p className="text-destructive text-xs">{t('ruleTooLong')}</p>
      )}
      {!result.noControlChars && (
        <p className="text-destructive text-xs">{t('ruleControlChars')}</p>
      )}
    </div>
  );
}
