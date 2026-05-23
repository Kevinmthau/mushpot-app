const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

type HeaderReader = {
  get(name: string): string | null;
};

export const PRIVATE_NEXT_PATH_HEADER = "x-mushpot-private-next-path";

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
  const configuredAppUrl = stripTrailingSlashes(
    process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "",
  );

  return normalizeHttpOrigin(configuredAppUrl) ?? "";
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() ?? "";
}

function normalizeHttpOrigin(value: string) {
  try {
    const url = new URL(value);

    if (!HTTP_PROTOCOLS.has(url.protocol)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
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

  return normalizeHttpOrigin(`${protocol}://${host}`);
}

export function resolveAppOriginFromHeaders(headersList: HeaderReader) {
  const configuredAppOrigin = getConfiguredAppOrigin();
  const requestOrigin = getRequestOriginFromHeaders(headersList);

  if (!requestOrigin) {
    return configuredAppOrigin || null;
  }

  if (!configuredAppOrigin) {
    return requestOrigin;
  }

  return requestOrigin === configuredAppOrigin
    ? requestOrigin
    : configuredAppOrigin;
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
