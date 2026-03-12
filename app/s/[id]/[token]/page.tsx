import { notFound } from "next/navigation";
import type { CSSProperties, ImgHTMLAttributes } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";

export const dynamic = "force-dynamic";

type SharedDocPageProps = {
  params: Promise<{ id: string; token: string }>;
};

type SharedDoc = {
  title: string;
  content: string;
  updated_at: string;
};

type MarkdownNode = {
  type?: string;
  value?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownNode[];
};

function applyImageWidthAttributes(node: MarkdownNode) {
  const children = Array.isArray(node.children) ? node.children : [];

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const next = children[index + 1];

    if (
      child?.type === "image" &&
      next?.type === "text" &&
      typeof next.value === "string"
    ) {
      const parsedWidthToken = parseImageWidthTokenFromText(next.value);
      if (parsedWidthToken) {
        const data = (child.data ??= {});
        const hProperties = (data.hProperties ??= {});
        hProperties["data-width"] = parsedWidthToken.width;

        const remaining = next.value.slice(parsedWidthToken.consumedChars);
        if (remaining.length === 0) {
          children.splice(index + 1, 1);
        } else {
          next.value = remaining;
        }
      }
    }

    applyImageWidthAttributes(child);
  }
}

function remarkImageWidth() {
  return (tree: MarkdownNode) => {
    applyImageWidthAttributes(tree);
  };
}

function extractMarkdownImageWidth(node: unknown) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const properties = (node as { properties?: Record<string, unknown> }).properties;
  if (!properties || typeof properties !== "object") {
    return null;
  }

  const rawValue = properties["data-width"] ?? properties.dataWidth;
  if (Array.isArray(rawValue)) {
    return typeof rawValue[0] === "string" ? rawValue[0] : null;
  }

  return typeof rawValue === "string" ? rawValue : null;
}

function SharedMarkdownImage({
  node,
  style,
  ...imgProps
}: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const markdownWidth = extractMarkdownImageWidth(node);
  const nextStyle: CSSProperties | undefined = markdownWidth
    ? {
        ...(style ?? {}),
        width: markdownWidth,
        maxWidth: "100%",
        height: "auto",
      }
    : style;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote markdown images have unknown intrinsic sizes at render time.
    <img
      {...imgProps}
      alt={imgProps.alt ?? ""}
      style={nextStyle}
      loading="lazy"
      decoding="async"
    />
  );
}

async function fetchSharedDocument(id: string, token: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/get-shared-doc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ docId: id, token }),
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as SharedDoc;
}

export default async function SharedDocumentPage({ params }: SharedDocPageProps) {
  const { id, token } = await params;

  const document = await fetchSharedDocument(id, token);

  if (!document) {
    notFound();
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-6 sm:px-6 sm:py-10">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-4 py-6 sm:px-6 sm:py-8 md:px-10 md:py-10">
        <header className="mb-6 border-b border-[var(--line)] pb-4 sm:mb-8 sm:pb-5">
          <h1 className="font-[var(--font-writing)] text-3xl font-semibold tracking-tight text-[var(--ink)] sm:text-4xl">
            {document.title || "Untitled"}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Updated {formatRelativeTimestamp(document.updated_at)}
          </p>
        </header>

        <article className="markdown-body">
          <Markdown
            remarkPlugins={[remarkGfm, remarkImageWidth]}
            components={{
              img: SharedMarkdownImage,
            }}
          >
            {document.content}
          </Markdown>
        </article>
      </div>
    </main>
  );
}
