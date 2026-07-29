export const CAPTCHA_CONFIGURATION_ERROR_MESSAGE =
  "Sign-in is temporarily unavailable. Please try again later.";
export const CAPTCHA_REQUIRED_ERROR_MESSAGE =
  "Complete the security check, then try again.";

type CaptchaEnvironment = {
  NODE_ENV?: string;
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
};

export function getCaptchaConfiguration(
  environment: CaptchaEnvironment = process.env,
) {
  const siteKey =
    environment.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;

  return {
    siteKey,
    required: siteKey !== null,
    configurationError:
      environment.NODE_ENV === "production" && siteKey === null,
  };
}

export function normalizeCaptchaToken(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim() || null;
}
