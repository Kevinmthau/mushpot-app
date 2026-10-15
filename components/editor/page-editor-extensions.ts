import {
  mergeAttributes,
  Node,
  type Extensions,
  type JSONContent,
} from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { renderToHTMLString } from "@tiptap/static-renderer";

import {
  canonicalizePageDocument,
  isSafePageLinkUrl,
  isSafePageMediaUrl,
} from "@/lib/page-document";

type SetVideoOptions = {
  src: string;
  poster?: string | null;
  alt?: string | null;
  width?: number | null;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: {
      setVideo: (options: SetVideoOptions) => ReturnType;
    };
  }
}

function parseDimension(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return null;
}

/** The stock image node with base64 and unsafe persisted URLs disabled. */
export const PageImage = Image.extend({
  parseHTML() {
    return [
      {
        tag: 'img[src]:not([src^="data:"])',
        getAttrs: (element) =>
          isSafePageMediaUrl((element as HTMLElement).getAttribute("src"))
            ? null
            : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const src = HTMLAttributes.src;
    if (!isSafePageMediaUrl(src)) return ["span", { "data-invalid-media": "" }];

    const width = parseDimension(HTMLAttributes.width);
    const height = parseDimension(HTMLAttributes.height);
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, {
        src,
        ...(typeof HTMLAttributes.alt === "string"
          ? { alt: HTMLAttributes.alt }
          : { alt: "" }),
        ...(typeof HTMLAttributes.title === "string"
          ? { title: HTMLAttributes.title }
          : {}),
        ...(width === null ? {} : { width }),
        ...(height === null ? {} : { height }),
        loading: "lazy",
        decoding: "async",
      }),
    ];
  },
}).configure({
  allowBase64: false,
  inline: false,
  resize: false,
});

/** A leaf block node; video URLs remain data, never executable markup. */
export const PageVideo = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        rendered: false,
        parseHTML: (element) => element.getAttribute("src"),
      },
      poster: {
        default: null,
        rendered: false,
        parseHTML: (element) => element.getAttribute("poster"),
      },
      alt: {
        default: null,
        rendered: false,
        parseHTML: (element) =>
          element.getAttribute("aria-label") ?? element.getAttribute("alt"),
      },
      width: {
        default: null,
        rendered: false,
        parseHTML: (element) => parseDimension(element.getAttribute("width")),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "video[src]",
        getAttrs: (element) => {
          const video = element as HTMLElement;
          const src = video.getAttribute("src");
          const poster = video.getAttribute("poster");
          return isSafePageMediaUrl(src) &&
              (poster === null || isSafePageMediaUrl(poster))
            ? null
            : false;
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { src, poster, alt, width } = node.attrs;
    if (!isSafePageMediaUrl(src)) {
      return ["span", { "data-invalid-media": "" }];
    }

    const normalizedWidth = parseDimension(width);
    return [
      "video",
      {
        src,
        ...(isSafePageMediaUrl(poster) ? { poster } : {}),
        ...(typeof alt === "string" ? { "aria-label": alt } : {}),
        ...(normalizedWidth === null ? {} : { width: normalizedWidth }),
        controls: "",
        playsinline: "",
        preload: "metadata",
      },
    ];
  },

  addCommands() {
    return {
      setVideo:
        (options) =>
        ({ commands }) =>
          isSafePageMediaUrl(options.src) &&
          (options.poster == null || isSafePageMediaUrl(options.poster))
            ? commands.insertContent({ type: this.name, attrs: options })
            : false,
    };
  },
});

export const PAGE_EDITOR_EXTENSIONS: Extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: {
      autolink: true,
      defaultProtocol: "https",
      enableClickSelection: false,
      HTMLAttributes: {
        class: null,
        rel: "noopener noreferrer",
        target: "_blank",
      },
      isAllowedUri: (url) => isSafePageLinkUrl(url),
      linkOnPaste: true,
      openOnClick: false,
      protocols: [],
      shouldAutoLink: (url) => isSafePageLinkUrl(url),
    },
  }),
  TableKit.configure({
    table: {
      allowTableNodeSelection: true,
      renderWrapper: true,
      resizable: false,
    },
  }),
  PageImage,
  PageVideo,
];

/** Render validated page content with the exact schema used by the editor. */
export function renderPageDocumentHtml(value: unknown) {
  const document = canonicalizePageDocument(value);
  return renderToHTMLString({
    content: document.content as JSONContent,
    extensions: PAGE_EDITOR_EXTENSIONS,
  });
}
