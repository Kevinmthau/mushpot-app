import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SharedDocumentPageClient } from "@/components/editor/shared-document-page-client";

function render(content: string) {
  return renderToStaticMarkup(createElement(SharedDocumentPageClient, {
    content, documentId: "document", shareToken: "token", title: "Document",
    updatedAt: "2026-09-17T12:00:00.000Z",
  }));
}

describe("shared document link previews", () => {
  it.each([
    "https://example.com/story",
    "<https://example.com/story>",
    "[https://example.com/story](https://example.com/story)",
    "[https://example.com/a\\|b](https://example.com/a%7Cb)",
    "[https://example.com/a\\[b\\]\\&copy;=yes](https://example.com/a[b]&amp;copy;=yes)",
    "[https://example.com/story][page]\n\n[page]: https://example.com/story",
    "[https://example.com/story][]\n\n[https://example.com/story]: https://example.com/story",
    "[https://example.com/story]\n\n[https://example.com/story]: https://example.com/story",
    "[https://example.com/story][ Page   URL ]\n\n[page url]: <https://example.com/story> \"Story title\"",
    "[https://example.com/a\\*b\\*][page]\n\n[page]: https://example.com/a*b*",
    "[https://example.com/a\\|b][page]\n\n[page]: https://example.com/a%7Cb",
    "[https://example.com/a&amp;b][page]\n\n[page]: https://example.com/a&amp;b",
    "[https://example.com/a[b]][page]\n\n[page]: https://example.com/a[b]",
  ])("previews a standalone URL paragraph: %s", (content) => {
    const html = render(content);
    expect(html).toContain('class="link-preview"');
    expect(html).not.toContain('<p><div class="link-preview"');
  });

  it.each([
    "Read https://example.com/story for details.",
    "[Read the story](https://example.com/story)",
    "[**https://example.com/story**](https://example.com/story)",
    "`https://example.com/story`",
    "```\nhttps://example.com/story\n```",
    "> https://example.com/story",
    "- https://example.com/story",
    "- Item\n\n  https://example.com/story",
    "https://example.com/one\nhttps://example.com/two",
    "![https://example.com/story](https://example.com/image.png)",
    "[https://example.com/story][missing]",
    "[https://example.com/story][]",
    "[https://example.com/story]",
    "[https://example.com/story][page]\n\n[page]: https://example.com/elsewhere",
    "[Read this][page]\n\n[page]: https://example.com/story",
    "[https://example.com/story]()\n\n[https://example.com/story]: https://example.com/story",
    "[**https://example.com/story**][page]\n\n[page]: https://example.com/story",
    "[https://example.com/a*b*][page]\n\n[page]: https://example.com/a*b*",
    "[https://example.com/a`b`][page]\n\n[page]: https://example.com/a`b`",
    "[https://example.com/a~b~][page]\n\n[page]: https://example.com/a~b~",
    "[https://example.com/a~~b~~][page]\n\n[page]: https://example.com/a~~b~~",
    "> [https://example.com/story][page]\n\n[page]: https://example.com/story",
    "[https://example.com/a*b*](https://example.com/a*b*)",
    "[https://example.com/a`b`](https://example.com/a`b`)",
    "[https://example.com/a~b~](https://example.com/a~b~)",
  ])("preserves inline, custom, literal, and nested content: %s", (content) => {
    expect(render(content)).not.toContain('class="link-preview"');
  });

  it("preserves image width tokens alongside a link preview", () => {
    const html = render("https://example.com/story\n\n![Photo](https://example.com/image.png){width=50%}");
    expect(html).toContain('class="link-preview"');
    expect(html).toContain("image.png");
    expect(html).toContain('style="width:50%"');
  });
});
