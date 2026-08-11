import { isAuthApiError } from '@supabase/supabase-js';

// Maps Supabase Auth error codes to translation keys under the
// `SignupPage` / `LoginPage` namespaces. Codes not listed here (and
// any 5xx / missing-message response, e.g. a broken SMTP relay
// returning an empty `{}` body) fall back to `errorGeneric`.
const CODE_TO_MESSAGE_KEY: Record<string, string> = {
  user_already_exists: 'errorUserExists',
  email_exists: 'errorUserExists',
  identity_already_exists: 'errorUserExists',
  weak_password: 'errorWeakPassword',
  email_address_invalid: 'errorInvalidEmail',
  email_address_not_authorized: 'errorInvalidEmail',
  over_email_send_rate_limit: 'errorRateLimit',
  over_request_rate_limit: 'errorRateLimit',
  signup_disabled: 'errorSignupDisabled',
  email_provider_disabled: 'errorSignupDisabled',
  invalid_credentials: 'errorInvalidCredentials',
  user_banned: 'errorUserBanned',
  email_not_confirmed: 'errorEmailNotConfirmed',
};

/**
 * Returns the translation key (within the caller's namespace) that
 * best summarizes an auth error, without ever surfacing the raw
 * `error.message` — which may come straight from the auth server
 * (e.g. an SMTP relay failure) and isn't meant for end users.
 */
export function getAuthErrorMessageKey(error: unknown): string {
  if (isAuthApiError(error) && error.code && CODE_TO_MESSAGE_KEY[error.code]) {
    return CODE_TO_MESSAGE_KEY[error.code];
  }
  return 'errorGeneric';
}

/**
 * Structured, non-sensitive details for `console.error`, so the raw
 * failure (SMTP rejection, status code, etc.) stays inspectable in
 * devtools without ever including credentials or tokens — those are
 * never part of the auth-js error object to begin with.
 */
export function getAuthErrorLogDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const { name, message } = error;
    const code = isAuthApiError(error) ? error.code : undefined;
    const status = isAuthApiError(error) ? error.status : undefined;
    return { name, code, status, message };
  }
  return { error: String(error) };
}
