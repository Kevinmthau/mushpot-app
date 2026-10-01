"use client";

import type { ComponentPropsWithoutRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { isSupportedVideoUrl } from "@/components/editor/image-upload-utils";
import { getDocumentDisplayTitle } from "@/lib/documents";
import { remarkImageWidth } from "@/lib/markdown/remark-image-width";
import {
  appendFirstFrameFragment,
  parseVideoPosterFromTitle,
} from "@/lib/markdown/video-poster";

// Keep the reading styles self-contained: downloaded files do not load the
// application's Tailwind bundle or Next.js font assets.
export const DOCUMENT_HTML_STYLES = `
:root {
  --ink: #1f2a2f;
  --line: #d8d6ca;
  --accent: #2f5966;
  --font-ui: "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-writing: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { min-height: 100%; background: #fff; }
body { margin: 0; color: var(--ink); font-family: var(--font-ui); }
main { width: 100%; max-width: 800px; margin: 0 auto; padding: 2rem 1rem 5rem; }
.document-html-title, .markdown-body {
  font-family: var(--font-writing);
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.75;
  letter-spacing: normal;
}
.document-html-title { margin: 0 0 1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4,
.markdown-body h5, .markdown-body h6 {
  font-family: var(--font-ui);
  font-size: inherit;
  font-weight: inherit;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 1.8em 0 0.5em;
}
.markdown-body h1 { font-size: 2rem; }
.markdown-body h2 { font-size: 1.5rem; }
.markdown-body p, .markdown-body ul, .markdown-body ol,
.markdown-body blockquote, .markdown-body pre { margin: 1em 0; }
.markdown-body p, .markdown-body li, .markdown-body blockquote {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.markdown-body ul, .markdown-body ol { padding-left: 1.5rem; }
.markdown-body a {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--line);
  text-underline-offset: 0.2em;
}
.markdown-body a:hover { color: var(--accent); }
.markdown-body code {
  font-family: var(--font-writing);
  background: #ece9de;
  padding: 0.12rem 0.35rem;
  border-radius: 0.4rem;
  font-size: 0.92em;
}
.markdown-body pre { background: #ece9de; border-radius: 0.75rem; padding: 1rem; overflow-x: auto; }
.markdown-body pre code { padding: 0; background: transparent; }
.markdown-body blockquote {
  border-left: 3px solid #b5c2bf;
  margin-left: 0;
  padding-left: 1rem;
  color: #4d6168;
}
.markdown-body hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
.document-html-media { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 0.75rem; background: #f5f3ec; }
.markdown-table-preview {
  display: block;
  width: 100%;
  min-width: 0;
  overflow-x: auto;
  margin: 1em 0;
  -webkit-overflow-scrolling: touch;
}
.markdown-body > .markdown-table-preview {
  width: max(100%, calc(100vw - 2rem));
  margin-left: min(0px, calc(50% - 50vw + 1rem));
}
.markdown-table-preview table { width: 100%; min-width: 100%; border-collapse: collapse; table-layout: auto; }
.markdown-table-preview th, .markdown-table-preview td {
  min-width: clamp(8rem, 18vw, 10rem);
  max-width: 28rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--line);
  vertical-align: top;
  white-space: normal;
  overflow-wrap: anywhere;
}
.markdown-table-preview th { background: #f5f3ec; font-weight: 700; }
@media (max-width: 639px) {
  .markdown-body h1 { font-size: 1.7rem; }
  .markdown-body h2 { font-size: 1.3rem; }
}
@media (min-width: 640px) {
  main { padding-top: 3rem; padding-right: 1.25rem; padding-left: 1.25rem; }
  .document-html-title, .markdown-body { font-size: 1.25rem; }
}
@media (min-width: 768px) { main { padding-right: 0; padding-left: 0; } }
@media print {
  main { max-width: none; padding: 0; }
  .markdown-body > .markdown-table-preview { width: 100%; margin-left: 0; }
}
`;

function ExportMarkdownMedia({ alt, src, style, title }: ComponentPropsWithoutRef<"img">) {
  if (typeof src !== "string" || !src) return null;

  if (isSupportedVideoUrl(src)) {
    const candidatePoster = parseVideoPosterFromTitle(title);
    // Poster URLs are stored in Markdown titles, so ReactMarkdown's URL
    // transform has not seen them. Apply the same filter before exporting.
    const poster = candidatePoster ? defaultUrlTransform(candidatePoster) : "";
    return (
      <video
        aria-label={alt || "Video"}
        className="document-html-media"
        controls
        data-export-poster={poster || undefined}
        data-export-src={poster ? src : appendFirstFrameFragment(src)}
        playsInline
        preload="none"
        style={style}
      />
    );
  }

  return (
    // The exporter sets src after resolving owned media. Keeping the URL in a
    // data attribute prevents the temporary render from starting downloads.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt ?? ""}
      className="document-html-media"
      data-export-src={src}
      style={style}
    />
  );
}

const markdownComponents: Components = {
  a: ({ children, href, ...props }) => {
    // ReactMarkdown's source AST is not a DOM attribute.
    delete props.node;
    return (
      <a
        {...props}
        href={href || undefined}
        rel="noopener noreferrer"
        target={href?.startsWith("#") ? undefined : "_blank"}
      >
        {children}
      </a>
    );
  },
  img: ExportMarkdownMedia,
  table: ({ children }) => (
    <div aria-label="Table" className="markdown-table-preview" role="region" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function renderDocumentHtmlBody({ title, content }: { title: string; content: string }) {
  const container = document.createElement("div");
  let renderFailure: { error: unknown } | undefined;
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      renderFailure = { error };
    },
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.unmount();
  };

  try {
    flushSync(() => root.render(
      <main>
        <h1 className="document-html-title">{getDocumentDisplayTitle(title)}</h1>
        <article className="markdown-body">
          <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkImageWidth]}>
            {content}
          </ReactMarkdown>
        </article>
      </main>,
    ));
    if (renderFailure) throw renderFailure.error;
    return { container, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
