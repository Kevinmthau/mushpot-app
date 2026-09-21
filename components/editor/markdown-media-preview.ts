import type { SyntaxNode } from "@lezer/common";
import { type EditorView, WidgetType } from "@codemirror/view";

import { isSupportedVideoUrl } from "@/components/editor/image-upload-utils";
import { normalizeDocumentMediaUrl } from "@/lib/document-media";
import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";
import { getInlineText, parseInlineContent } from "@/lib/markdown/inline";
import {
  emptyReferenceDefinitions,
  parseMarkdownLinkDestination,
  type MarkdownReferenceDefinitions,
} from "@/lib/markdown/links";
import {
  appendFirstFrameFragment,
  parseVideoPosterFromTitle,
} from "@/lib/markdown/video-poster";

export function createMarkdownMediaPreviewElement(
  src: string,
  altText: string,
  width: string | null,
  poster: string | null,
) {
  const isVideo = isSupportedVideoUrl(src);
  const wrapper = document.createElement("span");
  wrapper.className = isVideo
    ? "cm-md-media-preview cm-md-video-preview"
    : "cm-md-media-preview cm-md-image-preview";
  wrapper.setAttribute("aria-label", altText || (isVideo ? "Video" : "Image"));
  // Percentages belong to the editor line or table cell, not the media's
  // intrinsic inline-block size. Keep the image fitted to that sized wrapper.
  const mediaWidth = width?.endsWith("%") ? "100%" : width;
  if (width?.endsWith("%")) wrapper.style.width = width;

  if (isVideo) {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (poster) {
      video.poster = poster;
      video.src = src;
    } else {
      video.src = appendFirstFrameFragment(src);
    }
    if (mediaWidth) {
      video.style.width = mediaWidth;
    }

    wrapper.appendChild(video);
    return wrapper;
  }

  const image = document.createElement("img");
  image.src = src;
  image.alt = altText;
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  if (mediaWidth) {
    image.style.width = mediaWidth;
  }

  wrapper.appendChild(image);
  return wrapper;
}

export class MarkdownMediaPreviewWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly altText: string,
    private readonly width: string | null,
    private readonly poster: string | null,
  ) {
    super();
  }

  eq(other: MarkdownMediaPreviewWidget) {
    return (
      this.src === other.src &&
      this.altText === other.altText &&
      this.width === other.width &&
      this.poster === other.poster
    );
  }

  toDOM() {
    return createMarkdownMediaPreviewElement(
      this.src,
      this.altText,
      this.width,
      this.poster,
    );
  }
}

export function parseMarkdownImage(
  view: EditorView,
  syntaxNode: SyntaxNode,
  getReferences: () => MarkdownReferenceDefinitions,
) {
  const read = (from: number, to: number) => view.state.doc.sliceString(from, to);
  const image = parseMarkdownLinkDestination(read, syntaxNode, getReferences);
  if (!image?.href) return null;
  const altText = getInlineText(parseInlineContent(
    { slice: read }, syntaxNode, { references: emptyReferenceDefinitions },
    image.labelFrom, image.labelTo,
  ));
  const to = syntaxNode.to;
  const suffix = read(to, view.state.doc.lineAt(to).to);
  const width = parseImageWidthTokenFromText(suffix);
  return {
    altText,
    poster: normalizeDocumentMediaUrl(parseVideoPosterFromTitle(image.title) ?? "") || null,
    replaceTo: to + (width?.consumedChars ?? 0),
    url: normalizeDocumentMediaUrl(image.href),
    width: width?.width ?? null,
  };
}
