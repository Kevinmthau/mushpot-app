import { getLinkPreview, LinkPreviewError } from "@/lib/link-preview-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  try {
    const metadata = await getLinkPreview(url);
    return Response.json(metadata, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (error) {
    const status = error instanceof LinkPreviewError ? error.status : 502;
    const message = error instanceof LinkPreviewError ? error.message : "Link preview unavailable.";
    return Response.json({ error: message }, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      },
    });
  }
}
