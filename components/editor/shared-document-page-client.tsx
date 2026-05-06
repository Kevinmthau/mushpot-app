import {
  Children,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { getReadingTimeFromText } from "@/lib/document-stats";
import { getDocumentDisplayTitle } from "@/lib/documents";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";

type SharedDocumentPageClientProps = {
  content: string;
  documentId: string;
  title: string;
  updatedAt: string;
};

type ImageLikeElementProps = {
  src?: string;
  style?: CSSProperties;
};

function isImageLikeElement(node: ReactNode): node is ReactElement<ImageLikeElementProps> {
  return (
    isValidElement(node) &&
    typeof node.props === "object" &&
    node.props !== null &&
    "src" in node.props
  );
}

function SharedMarkdownParagraph({ children }: { children?: ReactNode }) {
  const nodes = Children.toArray(children);
  const nextChildren: ReactNode[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const child = nodes[index];

    if (!isImageLikeElement(child)) {
      nextChildren.push(child);
      continue;
    }

    const trailingNode = nodes[index + 1];
    if (typeof trailingNode !== "string") {
      nextChildren.push(child);
      continue;
    }

    const parsedWidthToken = parseImageWidthTokenFromText(trailingNode);
    if (!parsedWidthToken) {
      nextChildren.push(child);
      continue;
    }

    const style: CSSProperties = {
      ...child.props.style,
      width: parsedWidthToken.width,
    };
    nextChildren.push(cloneElement(child, { style }));

    const remainingText = trailingNode.slice(parsedWidthToken.consumedChars);
    if (remainingText.length > 0) {
      nextChildren.push(remainingText);
    }

    index += 1;
  }

  return <p>{nextChildren}</p>;
}

function SharedMarkdownImage({
  alt,
  src,
  style,
}: ComponentPropsWithoutRef<"img">) {
  if (typeof src !== "string" || src.length === 0) {
    return null;
  }

  return (
    // Shared markdown can reference arbitrary remote images without known dimensions.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt ?? ""}
      className="rounded-xl border border-[var(--line)] bg-[#f5f3ec]"
      decoding="async"
      loading="lazy"
      src={src}
      style={style}
    />
  );
}

const markdownComponents: Components = {
  a: ({ children, href }) => (
    <a
      href={href}
      rel="noreferrer"
      target="_blank"
      className="underline decoration-[var(--line)] underline-offset-4 transition hover:text-[var(--accent)]"
    >
      {children}
    </a>
  ),
  img: SharedMarkdownImage,
  p: SharedMarkdownParagraph,
};

export function SharedDocumentPageClient({
  content,
  documentId,
  title,
  updatedAt,
}: SharedDocumentPageClientProps) {
  const readingTime = getReadingTimeFromText(content);
  const formattedUpdated = formatRelativeTimestamp(updatedAt);

  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <h1 className="editor-title-input m-0 mb-4 whitespace-pre-wrap break-words text-[var(--ink)]">
          {getDocumentDisplayTitle(title)}
        </h1>

        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          <Link
            href="/"
            replace
            prefetch={false}
            aria-label="Back to documents"
            title="Back to documents"
            className="transition hover:text-[var(--ink)]"
          >
            {readingTime} min
          </Link>
          <span>•</span>
          <span>{formattedUpdated}</span>
        </div>

        <article
          className="markdown-body pb-24"
          data-document-id={documentId}
        >
          <ReactMarkdown
            components={markdownComponents}
            remarkPlugins={[remarkGfm]}
          >
            {content}
          </ReactMarkdown>
        </article>
      </main>
    </div>
  );
}
