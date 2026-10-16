import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HtmlDocumentPreview } from "@/components/editor/html-document-preview";

const SOURCE = "<!doctype html><html><body><script>run()</script><p>Preview</p></body></html>";

describe("HtmlDocumentPreview", () => {
  it("renders public previews with an opaque script-disabled sandbox", () => {
    const rendered = renderToStaticMarkup(
      createElement(HtmlDocumentPreview, { source: SOURCE, title: "Shared" }),
    );

    expect(rendered).toContain("sandbox=\"\"");
    expect(rendered).toContain("referrerPolicy=\"no-referrer\"");
    expect(rendered).toContain("script-src &#x27;none&#x27;");
    expect(rendered).not.toContain("allow-same-origin");
    expect(rendered).not.toContain("allow-modals");
    expect(rendered).not.toContain("Enable interactions");
  });

  it("offers the interaction toggle only in the owner editor", () => {
    const rendered = renderToStaticMarkup(
      createElement(HtmlDocumentPreview, {
        allowInteractionsControl: true,
        source: SOURCE,
        title: "Owner",
      }),
    );
    expect(rendered).toContain("Enable interactions");
    expect(rendered).toContain("Scripts are off");
  });
});
