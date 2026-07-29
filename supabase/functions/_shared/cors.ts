function normalizeHttpOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins() {
  const configuredValues = [
    ...(Deno.env.get("ALLOWED_ORIGINS") ?? "").split(","),
    Deno.env.get("APP_URL") ?? "",
    Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "",
    Deno.env.get("SITE_URL") ?? "",
  ];

  return new Set(
    configuredValues
      .map(normalizeHttpOrigin)
      .filter((origin): origin is string => origin !== null),
  );
}

export function isCorsOriginAllowed(request: Request) {
  const origin = request.headers.get("Origin");
  return !origin || getAllowedOrigins().has(origin);
}

export function getCorsHeaders(request: Request) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const origin = request.headers.get("Origin");

  if (origin && getAllowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}
