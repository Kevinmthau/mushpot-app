"use client";

import { useEffect, useRef, useState } from "react";

import { getLinkPreview } from "@/lib/link-preview-client";
import { type LinkPreviewMetadata, normalizeLinkPreviewUrl } from "@/lib/link-preview";

const PREVIEW_LOAD_DELAY_MS = 500;

type LinkPreviewCardProps = {
  url: string;
  onLoad?: () => void;
};

export function LinkPreviewCard(props: LinkPreviewCardProps) {
  return <LinkPreviewCardContent key={props.url} {...props} />;
}

function LinkPreviewCardContent({ url, onLoad }: LinkPreviewCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [metadata, setMetadata] = useState<LinkPreviewMetadata | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const safeUrl = normalizeLinkPreviewUrl(url);

  useEffect(() => {
    if (!safeUrl || !containerRef.current) return;
    let cancelled = false;
    let requested = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (cancelled || requested) return;
      requested = true;
      // Typing a standalone URL replaces this card on every keystroke. Wait
      // for a pause before adding a request to the shared client queue.
      timeout = setTimeout(() => {
        void getLinkPreview(safeUrl).then((result) => {
          if (!cancelled) setMetadata(result);
        });
      }, PREVIEW_LOAD_DELAY_MS);
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          load();
        }
      }, { rootMargin: "600px" });
    if (observer) observer.observe(containerRef.current);
    else load();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      observer?.disconnect();
    };
  }, [safeUrl]);

  useEffect(() => {
    onLoad?.();
  }, [metadata, imageFailed, onLoad]);

  if (!safeUrl) return null;
  const hostname = new URL(safeUrl).hostname.replace(/^www\./, "");

  return (
    <div className="link-preview" ref={containerRef}>
      <a
        className={metadata ? "link-preview-card" : "link-preview-fallback"}
        href={safeUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        {metadata ? (
          <>
            <span className="link-preview-copy">
              <span className="link-preview-title">{metadata.title}</span>
              {metadata.description && (
                <span className="link-preview-description">{metadata.description}</span>
              )}
              <span className="link-preview-site">
                {metadata.siteName && <span>{metadata.siteName} · </span>}
                {hostname}
              </span>
            </span>
            {metadata.image && !imageFailed && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt=""
                className="link-preview-image"
                decoding="async"
                loading="lazy"
                onError={() => setImageFailed(true)}
                onLoad={onLoad}
                referrerPolicy="no-referrer"
                src={metadata.image}
              />
            )}
          </>
        ) : url}
      </a>
    </div>
  );
}
