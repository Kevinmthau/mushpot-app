"use client";

import { Turnstile } from "@marsidev/react-turnstile";
import { useState } from "react";

import { requestMagicLinkAction } from "@/app/auth/actions";
import { AuthSubmitButton } from "@/components/auth/auth-submit-button";
import { CAPTCHA_CONFIGURATION_ERROR_MESSAGE } from "@/lib/auth-captcha";

type AuthFormProps = {
  nextPath: string;
  message: string | null;
  error: string | null;
  turnstileSiteKey: string | null;
  captchaConfigurationError: boolean;
};

export function AuthForm({
  nextPath,
  message,
  error,
  turnstileSiteKey,
  captchaConfigurationError,
}: AuthFormProps) {
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaError, setCaptchaError] = useState(false);

  return (
    <form
      action={requestMagicLinkAction}
      className="w-full rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-6 shadow-[0_12px_32px_rgba(40,52,55,0.08)] sm:p-8"
    >
      <h1 className="font-[var(--font-writing)] text-2xl font-semibold tracking-tight text-[var(--ink)] sm:text-3xl">
        Enter your email
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        We&apos;ll send a magic link so you can start writing.
      </p>

      <input type="hidden" name="nextPath" value={nextPath} />
      <input type="hidden" name="captchaToken" value={captchaToken} />

      <label className="mt-5 block text-sm text-[var(--muted)] sm:mt-6" htmlFor="email">
        Email address
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        className="mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-base text-[var(--ink)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,89,102,0.2)]"
        placeholder="you@example.com"
      />

      {turnstileSiteKey ? (
        <div className="mt-6">
          <Turnstile
            siteKey={turnstileSiteKey}
            onSuccess={(token) => {
              setCaptchaToken(token);
              setCaptchaError(false);
            }}
            onExpire={() => setCaptchaToken("")}
            onTimeout={() => setCaptchaToken("")}
            onError={() => {
              setCaptchaToken("");
              setCaptchaError(true);
            }}
            onUnsupported={() => {
              setCaptchaToken("");
              setCaptchaError(true);
            }}
            options={{
              action: "request_magic_link",
              responseField: false,
              size: "flexible",
              theme: "light",
            }}
          />
          {captchaError ? (
            <p className="mt-2 text-sm text-[#9b2d34]" role="alert">
              The security check could not load. Check your connection and try
              again.
            </p>
          ) : null}
        </div>
      ) : null}

      <AuthSubmitButton
        disabled={
          captchaConfigurationError ||
          (turnstileSiteKey !== null && captchaToken.length === 0)
        }
      />

      {message ? <p className="mt-4 text-sm text-[#2e6558]">{message}</p> : null}
      {error ? <p className="mt-4 text-sm text-[#9b2d34]">{error}</p> : null}
      {captchaConfigurationError && !error ? (
        <p className="mt-4 text-sm text-[#9b2d34]" role="alert">
          {CAPTCHA_CONFIGURATION_ERROR_MESSAGE}
        </p>
      ) : null}
    </form>
  );
}
