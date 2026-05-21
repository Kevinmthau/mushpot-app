const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

type HeaderReader = {
  get(name: string): string | null;
};

export function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

export function normalizeInternalPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  try {
    const parsedUrl = new URL(value, "https://mushpot.local");
    if (parsedUrl.origin !== "https://mushpot.local") {
      return "/";
    }

    return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return "/";
  }
}

export function normalizeInternalPathFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? normalizeInternalPath(value) : "/";
}

export function getConfiguredAppOrigin() {
  return stripTrailingSlashes(process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "");
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() ?? "";
}

export function getRequestOriginFromHeaders(headersList: HeaderReader) {
  const host = firstForwardedValue(
    headersList.get("x-forwarded-host") ?? headersList.get("host"),
  );

  if (!host) {
    return null;
  }

  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const isLocalhost = LOCALHOST_HOSTNAMES.has(hostname);
  const forwardedProto = firstForwardedValue(headersList.get("x-forwarded-proto"));
  const protocol = forwardedProto || (isLocalhost ? "http" : "https");

  return `${protocol}://${host}`;
}

export function resolveAppOriginFromHeaders(headersList: HeaderReader) {
  const configuredAppOrigin = getConfiguredAppOrigin();
  const requestOrigin = getRequestOriginFromHeaders(headersList);
  let requestHostname = "";
  if (requestOrigin) {
    try {
      requestHostname = new URL(requestOrigin).hostname;
    } catch {
      requestHostname = "";
    }
  }
  const isLocalhost = LOCALHOST_HOSTNAMES.has(requestHostname);

  return isLocalhost && configuredAppOrigin
    ? configuredAppOrigin
    : requestOrigin ?? configuredAppOrigin;
}

type AuthRedirectParams = {
  error?: string;
  sent?: "1";
};

export function buildAuthRedirectPath(
  nextPath: string,
  params: AuthRedirectParams = {},
) {
  const searchParams = new URLSearchParams({ next: normalizeInternalPath(nextPath) });

  if (params.error) {
    searchParams.set("error", params.error);
  }

  if (params.sent) {
    searchParams.set("sent", params.sent);
  }

  return `/auth?${searchParams.toString()}`;
}
