// @vitest-environment jsdom

import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  markdownRichTextPaste,
  richTextHtmlToMarkdown,
} from "@/components/editor/markdown-rich-text-paste";
import { markdownLinkPaste } from "@/components/editor/markdown-link-paste";
import { parseMarkdownTable } from "@/lib/markdown/table";
import { remarkImageWidth } from "@/lib/markdown/remark-image-width";

const syntaxTreeMock = vi.hoisted(() => ({
  calls: 0,
  failOnCall: 0,
}));

vi.mock("@codemirror/language", async (importOriginal) => {
  const original = await importOriginal<typeof import("@codemirror/language")>();
  return {
    ...original,
    ensureSyntaxTree: (
      ...args: Parameters<typeof original.ensureSyntaxTree>
    ) => {
      syntaxTreeMock.calls += 1;
      if (syntaxTreeMock.calls === syntaxTreeMock.failOnCall) return null;
      return original.ensureSyntaxTree(...args);
    },
  };
});

const CHATGPT_HTML = `
  <p><strong>Yes. I would make Fusion providers pay Andromeda for the compute demand we bring them.</strong> That is potentially the cleanest business model.</p>
  <p>Andromeda becomes a distribution and brokerage platform for compute.</p>
  <h3>How it works</h3>
  <ol>
    <li>A customer buys an Andromeda computer for $2,499.</li>
    <li><strong>The provider pays Andromeda a commission,</strong> perhaps 10% to 15%.</li>
  </ol>
  <h3>Example economics</h3>
  <p>Assume a customer spends $500 per year on Fusion.</p>
  <table>
    <thead><tr><th></th><th>Amount</th></tr></thead>
    <tbody>
      <tr><td>Customer pays</td><td>$500</td></tr>
      <tr><td>Fusion provider retains (90%)</td><td>$450</td></tr>
      <tr><td>Andromeda receives (10%)</td><td>$50</td></tr>
    </tbody>
  </table>
  <p>At scale:</p>
  <table>
    <thead><tr><th>Active Fusion customers</th><th>Annual Andromeda revenue</th></tr></thead>
    <tbody>
      <tr><td>100,000</td><td>$5M</td></tr>
      <tr><td>1 million</td><td>$50M</td></tr>
    </tbody>
  </table>
  <h3>I would actually negotiate three revenue streams</h3>
  <ul><li><strong>Referral commission:</strong> Providers pay for customers.</li></ul>
`;

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  syntaxTreeMock.calls = 0;
  syntaxTreeMock.failOnCall = 0;
});

describe("rich-text Markdown paste", () => {
  it("preserves ChatGPT headings, emphasis, lists, and two-column tables", () => {
    const markdownSource = richTextHtmlToMarkdown(CHATGPT_HTML);

    expect(markdownSource).toContain(
      "**Yes. I would make Fusion providers pay Andromeda for the compute demand we bring them.** That is potentially the cleanest business model.",
    );
    expect(markdownSource).toContain("### How it works\n\n1. A customer buys");
    expect(markdownSource).toContain(
      "|  | Amount |\n| --- | ---: |\n| Customer pays | $500 |",
    );
    expect(markdownSource).toContain(
      "| Active Fusion customers | Annual Andromeda revenue |\n| --- | ---: |",
    );
    expect(markdownSource).toContain(
      "- **Referral commission:** Providers pay for customers.",
    );

    const firstTable = markdownSource!
      .slice(markdownSource!.indexOf("|  | Amount |"))
      .split("\n\n", 1)[0];
    const parsed = parseMarkdownTable(firstTable);
    expect(parsed?.header).toHaveLength(2);
    expect(parsed?.rows).toHaveLength(3);
    expect(parsed?.alignments).toEqual([null, "right"]);
  });

  it("inserts the converted document as one undoable paste", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Before after",
        selection: { anchor: 7, head: 12 },
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          markdownRichTextPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/html" ? CHATGPT_HTML : "degraded text"),
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toContain("Before \n\n**Yes. I would make");
    expect(view.state.doc.toString()).toContain("| Customer pays | $500 |");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Before after");
  });

  it("flushes pending DOM text and selection before converting rich paste", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Before",
        selection: { anchor: 6 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const line = view.contentDOM.querySelector<HTMLElement>(".cm-line")!;
    line.textContent = "Changed";
    const textNode = line.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, "Changed".length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? "<strong>X</strong>"
            : type === "text/plain"
              ? "X"
              : "",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Changed**X**");
  });

  it("clears staged rich metadata when another paste handler consumes the event", async () => {
    let consumeNextPaste = true;
    const competingPasteHandler = Prec.lowest(
      EditorView.domEventHandlers({
        paste() {
          if (!consumeNextPaste) return false;
          consumeNextPaste = false;
          return true;
        },
      }),
    );
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          competingPasteHandler,
        ],
      }),
    });
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    const consumedEvent = new Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(consumedEvent, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? "<strong>Rich</strong>"
            : type === "text/plain"
              ? "Rich"
              : "",
      },
    });

    view.contentDOM.dispatchEvent(consumedEvent);
    await Promise.resolve();

    expect(consumedEvent.defaultPrevented).toBe(true);
    expect(parser).toHaveBeenCalled();
    const plainEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(plainEvent, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => type === "text/plain" ? "Plain" : "",
      },
    });
    view.contentDOM.dispatchEvent(plainEvent);

    expect(view.state.doc.toString()).toBe("Plain");
  });

  it("leaves plain clipboard HTML to CodeMirror's native paste path", () => {
    expect(richTextHtmlToMarkdown("<p>Just plain text</p>")).toBeNull();
  });

  it("falls back safely for pathologically deep rich HTML", () => {
    const depth = 3_000;
    const source = `${"<div>".repeat(depth)}<strong>x</strong>${"</div>".repeat(depth)}`;

    expect(() => richTextHtmlToMarkdown(source)).not.toThrow();
    expect(richTextHtmlToMarkdown(source)).toBeNull();
  });

  it("rejects extreme raw nesting before it can block the paste handler", () => {
    const source = `${"<div>".repeat(50_000)}<strong>x</strong>`;
    const startedAt = performance.now();

    expect(richTextHtmlToMarkdown(source)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  }, 10_000);

  it("cannot bypass the raw nesting guard with malformed comments or attributes", () => {
    const nested = `${"<div>".repeat(3_000)}<strong>x</strong>`;
    for (const prefix of [
      "<!-->",
      "<!--->",
      "<!-- copied --!>",
      "<div data-copy=unquoted'value>",
    ]) {
      expect(richTextHtmlToMarkdown(`${prefix}${nested}`)).toBeNull();
    }
    expect(
      richTextHtmlToMarkdown(
        `<!-- ${"<div>".repeat(600)} --> <strong>Visible</strong>`,
      ),
    ).toBe("**Visible**");
  });

  it("does not mistake optional list-item end tags for deep nesting", () => {
    const source = `<ul>${Array.from(
      { length: 600 },
      (_, index) => `<li>Item ${index}`,
    ).join("")}</ul><strong>After</strong>`;

    const markdownSource = richTextHtmlToMarkdown(source);

    expect(markdownSource).toContain("- Item 0\n- Item 1");
    expect(markdownSource).toContain("- Item 599");
    expect(markdownSource).toContain("**After**");
  });

  it("falls back before oversized empty formatting runs can block paste", () => {
    const source = `<p>${"<strong></strong><em></em>".repeat(3_000)}</p>`;

    expect(richTextHtmlToMarkdown(source)).toBeNull();
  });

  it("enforces the DOM node cap before invoking the browser parser", () => {
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    const source = `<p>${"<span></span>".repeat(5_001)}<strong>Visible</strong></p>`;

    expect(richTextHtmlToMarkdown(source)).toBeNull();
    expect(parser).not.toHaveBeenCalled();
  });

  it("falls back before parsing oversized rich HTML", () => {
    const source = `<strong>${"x".repeat(1_000_000)}</strong>`;

    expect(richTextHtmlToMarkdown(source)).toBeNull();
  });

  it("rejects excessive raw attributes before invoking the browser parser", () => {
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    const attributes = Array.from(
      { length: 2_001 },
      (_, index) => `data-copy-${index}`,
    ).join(" ");
    const source = `<strong ${attributes}>Visible</strong>`;

    expect(source.length).toBeLessThan(1_000_000);
    expect(richTextHtmlToMarkdown(source)).toBeNull();
    expect(parser).not.toHaveBeenCalled();
  });

  it("makes clipboard resources inert before using the browser parser", () => {
    const nativeParse = DOMParser.prototype.parseFromString;
    const parsedSources: string[] = [];
    vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(
      function (this: DOMParser, source, type) {
        parsedSources.push(source);
        return nativeParse.call(this, source, type);
      },
    );

    const markdownSource = richTextHtmlToMarkdown(
      '<link rel="icon" href="https://attacker.example/icon.png"><iframe src="https://attacker.example/frame" srcdoc="<img src=https://attacker.example/nested>"></iframe><p><img data-mushpot-clipboard-resource-src="https://attacker.example/spoof.png" src="https://example.com/photo.png" alt="Photo"><strong style="color:red">Visible</strong></p>',
    );

    expect(markdownSource).toBe(
      "![Photo](https://example.com/photo.png)**Visible**",
    );
    expect(parsedSources).toHaveLength(1);
    expect(parsedSources[0]).not.toMatch(
      /\s(?:background|data|poster|src|srcdoc|srcset|style)=/i,
    );
    expect(parsedSources[0]).not.toContain("attacker.example");
    expect(parsedSources[0]).toContain(
      'data-mushpot-clipboard-resource-src="https://example.com/photo.png"',
    );
  });

  it("rejects stylesheets before invoking the browser parser", () => {
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");

    expect(
      richTextHtmlToMarkdown(
        '<style>@import "https://attacker.example/site.css"</style><strong>Visible</strong>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<link rel="preload stylesheet" href="https://attacker.example/site.css"><strong>Visible</strong>',
      ),
    ).toBeNull();
    expect(parser).not.toHaveBeenCalled();
  });

  it("rejects ambiguous noscript markup before invoking the browser parser", () => {
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");

    expect(
      richTextHtmlToMarkdown(
        '<noscript><img src="https://attacker.example/noscript.png"></noscript><strong>Visible</strong>',
      ),
    ).toBeNull();
    expect(parser).not.toHaveBeenCalled();
  });

  it("rejects foreign-namespace markup before browser reparsing can activate it", () => {
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");

    expect(
      richTextHtmlToMarkdown(
        '<math><annotation-xml encoding="text/html"><xmp><img src="https://attacker.example/math.png"></xmp></annotation-xml></math><strong>Visible</strong>',
      ),
    ).toBeNull();
    expect(parser).not.toHaveBeenCalled();
  });

  it("escapes table pipes without splitting a cell", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><tr><th>Name</th><th>Value</th></tr><tr><td>A | B</td><td>10</td></tr></table>",
      ),
    ).toContain("| A \\| B | 10 |");
  });

  it("preserves non-ASCII spacing at table-cell boundaries", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<table><tr><th>Heading</th></tr><tr><td>&nbsp;A\u2003B\u2002</td></tr></table>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toBe(
      "| Heading |\n| --- |\n| \u00a0A\u2003B\u2002 |",
    );
    expect(rendered.querySelector("tbody td")?.textContent).toBe(
      "\u00a0A\u2003B\u2002",
    );
  });

  it("escapes pipes inside table code spans and destinations", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<table><tr><th>Code</th><th>Link</th><th>Image</th></tr><tr><td><code>a|b</code></td><td><a href="https://example.com/a|b">Example</a></td><td><img src="https://example.com/image.png" title="A|B"></td></tr></table>',
    );

    expect(markdownSource).toContain(
      '| `a\\|b` | [Example](https://example.com/a%7Cb) | ![](https://example.com/image.png "A\\|B") |',
    );
    expect(parseMarkdownTable(markdownSource!)?.header).toHaveLength(3);
    expect(parseMarkdownTable(markdownSource!)?.rows[0]).toHaveLength(3);
  });

  it("defers table code with an unrepresentable backslash-pipe run", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><tr><th>Code</th></tr><tr><td><code>a\\|b</code></td></tr></table>",
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        "<table><tr><th>Code</th></tr><tr><td><code>a\\</code><code>|b</code></td></tr></table>",
      ),
    ).toBeNull();
  });

  it("preserves representable even backslash runs before table-code pipes", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<table><tr><th>Code</th></tr><tr><td><code>a\\\\|b</code></td></tr></table>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(parseMarkdownTable(markdownSource!)?.rows[0]).toHaveLength(1);
    expect(rendered.querySelector("tbody code")?.textContent).toBe("a\\\\|b");
  });

  it("preserves ampersands in text and destinations after rendering", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<p><strong>&amp;copy;</strong> <a href="https://example.com/?x=1&amp;copy;=yes">Example</a></p>',
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );

    expect(html).toContain("<strong>&amp;copy;</strong>");
    expect(html).toContain(
      '<a href="https://example.com/?x=1&amp;copy;=yes">Example</a>',
    );
  });

  it("encodes control whitespace in link destinations", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<a href="https://example.com/a&#10;&#10;---">Example</a>',
    );

    expect(markdownSource).toBe(
      "[Example](https://example.com/a%0A%0A---)",
    );
  });

  it("encodes backslashes in link destinations", () => {
    expect(
      richTextHtmlToMarkdown(
        '<a href="https://example.com/foo\\">Example</a>',
      ),
    ).toBe("[Example](https://example.com/foo%5C)");
  });

  it("resolves relative links and images against an explicit source base", () => {
    expect(
      richTextHtmlToMarkdown(
        '<base href="https://source.example/path/"><p><a href="child"><strong>Docs</strong></a> <img src="../image.png" alt="Image"></p>',
      ),
    ).toBe(
      "[**Docs**](https://source.example/path/child) ![Image](https://source.example/image.png)",
    );
    expect(
      richTextHtmlToMarkdown(
        '<base href="/unknown/"><a href="child"><strong>Docs</strong></a>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<base href="https://source.example/a/"><a href=""><strong>Home</strong></a>',
      ),
    ).toBe("[**Home**](https://source.example/a/)");
    expect(
      richTextHtmlToMarkdown(
        '<base href="https://first.example/a/"><base href="https://second.example/b/"><a href="x">X</a>',
      ),
    ).toBe("[X](https://first.example/a/x)");
    expect(richTextHtmlToMarkdown('<a href="/docs">Docs</a>')).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<base href="https://source.example/path/"><a href="/docs">Docs</a>',
      ),
    ).toBe("[Docs](https://source.example/docs)");
    expect(
      richTextHtmlToMarkdown(
        '<a href="child"><strong>Docs</strong></a>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><img src="photo.png" alt="Photo"><strong>Caption</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><img src="/photo.png" alt="Photo"><strong>Caption</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<base href="https://source.example/path/"><img src="/photo.png" alt="Photo">',
      ),
    ).toBe("![Photo](https://source.example/photo.png)");
    expect(
      richTextHtmlToMarkdown(
        '<a href="#section"><strong>Jump</strong></a>',
      ),
    ).toBe("[**Jump**](#section)");
  });

  it("requires a source base for base-dependent special HTTP URLs", () => {
    expect(
      richTextHtmlToMarkdown(
        '<a href="https:child"><strong>Docs</strong></a>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<img src="https:/photo.png" alt="Photo"><strong>Caption</strong>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<base href="https://source.example/path/"><a href="https:child"><strong>Docs</strong></a> <img src="https:/photo.png" alt="Photo">',
      ),
    ).toBe(
      "[**Docs**](https://source.example/path/child) ![Photo](https://source.example/photo.png)",
    );
  });

  it("escapes image titles without corrupting entities or quotes", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<img src="https://example.com/image.png" alt="Image" title="A\\&quot;B &amp;copy;">',
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html").querySelector("img");

    expect(rendered?.getAttribute("title")).toBe('A\\"B &copy;');
    const linkMarkdown = richTextHtmlToMarkdown(
      '<a href="https://example.com/docs" title="A\\&quot;B &amp;copy;">Docs</a>',
    );
    const linkHtml = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, linkMarkdown),
    );
    expect(
      new DOMParser()
        .parseFromString(linkHtml, "text/html")
        .querySelector("a")
        ?.getAttribute("title"),
    ).toBe('A\\"B &copy;');
  });

  it("omits non-content and visually hidden clipboard elements", () => {
    expect(
      richTextHtmlToMarkdown(
        '<div><script>hidden()</script><p hidden>SECRET</p><span style="visibility: hidden !important">NOPE</span><iframe>IFRAME</iframe><datalist><option>OPTION</option></datalist><strong>Hello</strong></div>',
      ),
    ).toBe("**Hello**");
  });

  it("does not serialize fallback children of replaced elements", () => {
    expect(
      richTextHtmlToMarkdown(
        "<p><canvas><strong>Canvas fallback</strong></canvas><video><em>Video fallback</em></video><strong>Visible</strong></p>",
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        "<canvas><strong>Canvas fallback</strong></canvas>",
      ),
    ).toBeNull();
  });

  it("does not serialize progress and meter fallback children", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><progress value="70"><strong>70 percent fallback</strong></progress><meter value="2"><em>2 fallback</em></meter><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<progress value="70"><strong>70 percent fallback</strong></progress>',
      ),
    ).toBeNull();
  });

  it("defers fragments whose stylesheets can hide serialized content", () => {
    expect(
      richTextHtmlToMarkdown(
        '<style>.hide{display:none}</style><p><span class="hide">SECRET</span><strong>Visible</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<link rel="stylesheet" href="https://example.com/paste.css"><p><img class="hide" src="https://example.com/pixel"><strong>Visible</strong></p>',
      ),
    ).toBeNull();
  });

  it("honors CSS declaration order and important visibility overrides", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><strong style="display:none;display:inline">Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><strong style="display:none!important;display:block">Hidden</strong><em>Visible</em></p>',
      ),
    ).toBe("*Visible*");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="display:none /* copied-site comment */">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="dis/**/play:none">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="display:none;display:">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="display:\\6e one">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="visibility:h\\69 dden">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="d\\69 splay:none">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="\\44 ISPLAY:\\4E one">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="display:none !\\69mportant;display:block">Hidden</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        `<p><span style='display:none;--x:";display:block"'>SECRET</span><strong>Visible</strong></p>`,
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        `<p><span style='display:none;--x:url(data:text/plain,;display:block)'>SECRET</span><strong>Visible</strong></p>`,
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="--d:none;display:var(--d)">SECRET</span><strong>Visible</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="display:none;display:not-a-display-value">SECRET</span><strong>Visible</strong></p>',
      ),
    ).toBeNull();
  });

  it("defers whitespace-preserving CSS that Markdown cannot represent", () => {
    expect(
      richTextHtmlToMarkdown(
        '<div style="white-space:pre-wrap"><strong>A  B\nC</strong></div>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<html><body style="white-space:pre-line"><strong>A  B\nC</strong></body></html>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<div style="white-space:normal"><strong>A  B\nC</strong></div>',
      ),
    ).toBe("**A B C**");
  });

  it("defers white-space-collapse values that Markdown cannot preserve", () => {
    for (const value of [
      "break-spaces",
      "preserve",
      "preserve-breaks",
      "preserve-spaces",
    ]) {
      expect(
        richTextHtmlToMarkdown(
          `<div style="white-space-collapse:${value}"><strong>A  B\nC</strong></div>`,
        ),
      ).toBeNull();
    }
    expect(
      richTextHtmlToMarkdown(
        '<html style="white-space-collapse:preserve"><body><strong>A  B</strong></body></html>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<div style="white-space-collapse:collapse"><strong>A  B\nC</strong></div>',
      ),
    ).toBe("**A B C**");
  });

  it("defers white-space overrides inside preformatted blocks", () => {
    for (const source of [
      '<pre style="white-space:normal"><code>a  b</code></pre>',
      '<pre><code><span style="white-space:normal">a  b</span></code></pre>',
      '<pre><code style="white-space:inherit">a  b</code></pre>',
      '<pre><code style="white-space-collapse:collapse">a  b</code></pre>',
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
  });

  it("defers inline CSS that adds or cancels Markdown formatting", () => {
    for (const source of [
      '<p><span style="font-weight:bold">Styled</span><em>Rich</em></p>',
      '<p><strong style="font-weight:normal">Not bold</strong></p>',
      '<p><span style="font-style:italic">Styled</span><strong>Rich</strong></p>',
      '<p><em style="font-style:normal">Not italic</em></p>',
      '<p><span style="text-decoration:line-through">Styled</span><strong>Rich</strong></p>',
      '<p><del style="text-decoration:none">Not deleted</del></p>',
      '<p><span style="text-decoration-line:line-through">Styled</span><strong>Rich</strong></p>',
      '<p><span style="text-transform:uppercase">Styled</span><strong>Rich</strong></p>',
      '<p><strong style="font-wei/**/ght:normal">Not bold</strong></p>',
      '<p><span style="font-weight:bold;font-weight:">Styled</span><em>Rich</em></p>',
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="text-transform:none"><strong>Rich</strong></span></p>',
      ),
    ).toBe("**Rich**");
  });

  it("defers inherited visibility overrides to the native paste path", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="visibility:hidden">Secret <strong style="visibility:visible">Visible</strong></span></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="visibility:hidden">Secret <strong style="visibility:initial">Visible</strong></span><em>After</em></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="visibility:hidden">Secret <strong style="all:initial">Visible</strong></span><em>After</em></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="visibility:hidden">Secret <strong style="visibility:unset">Still hidden</strong></span><em>After</em></p>',
      ),
    ).toBe("*After*");
  });

  it("does not serialize content hidden by additional inline CSS", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="content-visibility:hidden">SECRET</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="opacity:0">SECRET</span><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
    for (const style of [
      "clip-path:inset(50%)",
      "filter:opacity(0)",
      "transform:scale(0)",
    ]) {
      expect(
        richTextHtmlToMarkdown(
          `<p><span style="${style}">SECRET</span><strong>Visible</strong></p>`,
        ),
      ).toBeNull();
    }
    expect(
      richTextHtmlToMarkdown(
        '<p><img src="https://tracker.example/pixel.gif" width="0" height="0"><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
  });

  it("defers visual and layout CSS that the Markdown serializer cannot model", () => {
    for (const style of [
      "color:#0000",
      "color:#00000000",
      "color:rgb(0 0 0 / .0)",
      "color:rgba(0,0,0,.000001)",
      "color:#fff;background-color:#fff",
      "-webkit-text-fill-color:transparent",
      "opacity:.000001%",
      "vertical-align:-99999px",
      "-webkit-transform:scale(0)",
      "-webkit-filter:opacity(0)",
      "-webkit-mask:linear-gradient(transparent,transparent)",
      "margin-left:-9999px",
      "position:absolute;left:-9999px",
      "width:0;height:0;overflow:hidden",
      "inline-size:0;overflow:hidden",
      "block-size:0;overflow:hidden",
      "max-inline-size:0;overflow:clip",
      "max-block-size:0;overflow:clip",
      "min-inline-size:1px;overflow:hidden",
      "min-block-size:1px;overflow:hidden",
    ]) {
      expect(
        richTextHtmlToMarkdown(
          `<p><span style="${style}">SECRET</span><strong>Visible</strong></p>`,
        ),
      ).toBeNull();
    }
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="display:block"><strong>First</strong></span><span style="display:block"><em>Second</em></span></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<div style="display:inline"><strong>First</strong></div><div style="display:inline"><em>Second</em></div>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<div style="display:block"><strong>Visible</strong></div>',
      ),
    ).toBe("**Visible**");
    expect(
      richTextHtmlToMarkdown(
        '<p><span style="color:rgba(0,0,0,1);opacity:100%;vertical-align:middle"><strong>Visible</strong></span></p>',
      ),
    ).toBe("**Visible**");
  });

  it("defers font sizing that can hide or materially change rich text", () => {
    for (const style of [
      "font:0/0 sans-serif",
      "font:inherit",
      "font-size:calc(0px)",
      "font-size:1px",
    ]) {
      expect(
        richTextHtmlToMarkdown(
          `<p><span style="${style}">Secret</span><strong>Visible</strong></p>`,
        ),
      ).toBeNull();
    }
  });

  it("defers responsive image selection to the native paste path", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><img srcset="https://cdn.example/photo.png 1x" alt="Photo"><strong>Caption</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><img src="https://cdn.example/fallback.jpg" srcset="https://cdn.example/large.jpg 2x" alt="Photo"><strong>Caption</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<picture><source type="image/webp" srcset="https://cdn.example/photo.webp"><img src="https://cdn.example/photo.jpg" alt="Photo"></picture><strong>Caption</strong>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<picture hidden><source srcset="secret.webp"><img src="secret.jpg"></picture><strong>Visible</strong>',
      ),
    ).toBe("**Visible**");
  });

  it.each([
    ['width="120"', "120px"],
    ['style="width:240px"', "240px"],
    ['style="width:50%"', "50%"],
    ['width="0" style="width:240px"', "240px"],
  ])("preserves fixed image sizing from %s", (sizing, expectedWidth) => {
    const markdownSource = richTextHtmlToMarkdown(
      `<img src="https://example.com/photo.png" alt="Photo" ${sizing}>`,
    );
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, remarkImageWidth] },
        markdownSource,
      ),
    );
    const image = new DOMParser().parseFromString(html, "text/html").querySelector("img");

    expect(markdownSource).toContain(`{width=${expectedWidth}}`);
    expect(image?.style.width).toBe(expectedWidth);
  });

  it("resolves CSS image sizing before legacy attributes and defers conflicts", () => {
    expect(
      richTextHtmlToMarkdown(
        '<img src="https://example.com/photo.png" width="0" style="width:auto" alt="Photo">',
      ),
    ).toBe("![Photo](https://example.com/photo.png)");
    for (const sizing of [
      'style="width:240"',
      'style="width:calc(50% - 1rem)"',
      'style="width:0;min-width:100px"',
      'style="width:240px;aspect-ratio:1/1"',
      'style="inline-size:240px"',
      'width="120" height="80"',
    ]) {
      expect(
        richTextHtmlToMarkdown(
          `<img src="https://example.com/photo.png" alt="Photo" ${sizing}>`,
        ),
      ).toBeNull();
    }
  });

  it("does not treat invalid zero-valued CSS units as hidden images", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><img src="https://example.com/photo.png" style="width:0garbage" alt="Photo"><strong>Visible</strong></p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<p><img src="https://example.com/photo.png" style="width:0px" alt="Photo"><strong>Visible</strong></p>',
      ),
    ).toBe("**Visible**");
  });

  it("preserves visually present aria-hidden text", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><span aria-hidden="true">$</span><strong>100</strong></p>',
      ),
    ).toBe("$**100**");
  });

  it("omits unsafe image destinations and preserves unsafe link labels", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<p>Before<img src="data:image/png;base64,AAAA" alt="Data"><img src="blob:https://example.com/id" alt="Blob"><img src="javascript:alert(1)" alt="Script"><img alt="Missing"><a href="javascript:alert(1)">label</a> <strong>after</strong></p>',
    );

    expect(markdownSource).toBe("BeforeDataBlobScriptMissinglabel **after**");
    expect(markdownSource).not.toContain("![");
    expect(markdownSource).not.toContain("javascript:");
  });

  it("defers tables with row spans to the native paste path", () => {
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th>Name</th><th>Value</th></tr><tr><td rowspan="2">X</td><td>1</td></tr><tr><td>2</td></tr></table>',
      ),
    ).toBeNull();
  });

  it("defers oversized table colspans to the native paste path", () => {
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th colspan="1000000000">Heading</th></tr><tr><td>Value</td></tr></table>',
      ),
    ).toBeNull();
  });

  it("defers tables whose hidden structure would shift columns", () => {
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th>A</th><th>B</th></tr><tr><td style="visibility:hidden">Secret</td><td>Visible</td></tr></table>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th>A</th><th>B</th></tr><tr><td style="opacity:0">Secret</td><td>Visible</td></tr></table>',
      ),
    ).toBeNull();
  });

  it("defers legacy sizing attributes on table structure", () => {
    for (const source of [
      '<table width="320"><tr><th>A</th></tr><tr><td>B</td></tr></table>',
      '<table><colgroup><col width="120"></colgroup><tr><th>A</th></tr><tr><td>B</td></tr></table>',
      '<table><tr height="40"><th>A</th></tr><tr><td>B</td></tr></table>',
      '<table><tr><th>A</th></tr><tr><td width="120">B</td></tr></table>',
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
  });

  it("defers multi-row headers and nested tables", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><thead><tr><th>Group</th></tr><tr><th>Name</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>",
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        "<table><tr><th>Outer</th></tr><tr><td><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table></td></tr></table>",
      ),
    ).toBeNull();
  });

  it("defers preformatted blocks inside tables", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><tr><th>Code</th></tr><tr><td><pre><code>a  b\n  c</code></pre></td></tr></table>",
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        "<table><tr><th>H</th></tr><tr><td>A<hr>B</td></tr></table>",
      ),
    ).toBeNull();
  });

  it("uses only the final exact text-align declaration", () => {
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th style="vertical-align:right">A</th><th style="text-align:left;text-align:right">B</th></tr><tr><td>x</td><td>y</td></tr></table>',
      ),
    ).toContain("| --- | ---: |");
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th align="left" style="text-align:right">A</th></tr><tr><td>x</td></tr></table>',
      ),
    ).toContain("| ---: |");
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th align="right" style="text-align:start">A</th></tr></table>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><th style="text-align:justify">A</th></tr></table>',
      ),
    ).toBeNull();
  });

  it("preserves consistent body-cell alignment and defers conflicts", () => {
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><td style="text-align:center">A</td><td style="text-align:left">B</td></tr></table>',
      ),
    ).toContain("| :---: | --- |");
    expect(
      richTextHtmlToMarkdown(
        '<table><tr><td style="text-align:left">A</td></tr><tr><td style="text-align:right">B</td></tr></table>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<table style="text-align:center"><tr><td>A</td><td>B</td></tr></table>',
      ),
    ).toContain("| :---: | :---: |");
    expect(
      richTextHtmlToMarkdown(
        '<table><thead align="center"><tr><th>A</th></tr></thead><tbody align="center"><tr><td>B</td></tr></tbody></table>',
      ),
    ).toContain("| :---: |");
    expect(
      richTextHtmlToMarkdown(
        '<table><tr align="center"><th>A</th></tr><tr align="center"><td>B</td></tr></table>',
      ),
    ).toContain("| :---: |");
    expect(
      richTextHtmlToMarkdown(
        '<div style="text-align:center"><table><tr><th>Name</th></tr><tr><td>A</td></tr></table></div>',
      ),
    ).toContain("| :---: |");
    expect(
      richTextHtmlToMarkdown(
        '<div style="text-align:center"><table align="right"><tr><th>Name</th></tr><tr><td>A</td></tr></table></div>',
      ),
    ).toContain("| :---: |");
    expect(
      richTextHtmlToMarkdown(
        '<section align="right"><table><tr><th>Name</th></tr><tr><td>A</td></tr></table></section>',
      ),
    ).toContain("| --- |");
    expect(
      richTextHtmlToMarkdown(
        '<div align="center"><table><tr><th>Name</th></tr><tr><td>A</td></tr></table></div>',
      ),
    ).toContain("| :---: |");
  });

  it("serializes table row groups in visual order", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><tfoot><tr><td>Foot</td></tr></tfoot><tbody><tr><td>Body</td></tr></tbody><thead><tr><th>Name</th></tr></thead></table>",
      ),
    ).toBe("| Name |\n| --- |\n| Body |\n| Foot |");
  });

  it("separates block content inside table cells", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<table><tr><th>Notes</th></tr><tr><td><p>First</p><p>Second</p><ul><li>Third</li><li>Fourth</li></ul></td></tr></table>",
    );

    expect(markdownSource).toContain("| First Second Third Fourth |");
  });

  it("preserves visible table captions", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><caption><strong>Quarterly totals</strong></caption><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>",
      ),
    ).toBe(
      "**Quarterly totals**\n\n| Name | Value |\n| --- | ---: |\n| A | 1 |",
    );
  });

  it("falls back when a table has multiple visible captions", () => {
    expect(
      richTextHtmlToMarkdown(
        "<table><caption>One</caption><caption><strong>Two</strong></caption><tr><td>A</td></tr></table>",
      ),
    ).toBeNull();
  });

  it("keeps body-only table rows in the table body", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<table><tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(rendered.querySelector("thead")?.textContent).toBe("");
    expect(Array.from(rendered.querySelectorAll("tbody tr"), (row) => row.textContent)).toEqual([
      "A1",
      "B2",
    ]);
  });

  it("does not promote tbody row headers into a column-header row", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<table><tbody><tr><th scope="row">A</th><td>1</td></tr><tr><th scope="row">B</th><td>2</td></tr></tbody></table>',
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(rendered.querySelector("thead")?.textContent).toBe("");
    expect(Array.from(rendered.querySelectorAll("tbody tr"), (row) => row.textContent)).toEqual([
      "A1",
      "B2",
    ]);
  });

  it("keeps all-th scope=row rows in the table body", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<table><tbody><tr><th scope="row">A</th></tr><tr><th scope="row">B</th></tr></tbody></table>',
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(rendered.querySelector("thead")?.textContent).toBe("");
    expect(Array.from(rendered.querySelectorAll("tbody tr"), (row) => row.textContent))
      .toEqual(["A", "B"]);

    const rowGroupMarkdown = richTextHtmlToMarkdown(
      '<table><tbody><tr><th scope="rowgroup">Group A</th></tr><tr><th scope="rowgroup">Group B</th></tr></tbody></table>',
    );
    const rowGroupHtml = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, rowGroupMarkdown),
    );
    const rowGroupRendered = new DOMParser().parseFromString(
      rowGroupHtml,
      "text/html",
    );
    expect(rowGroupRendered.querySelector("thead")?.textContent).toBe("");
    expect(
      Array.from(
        rowGroupRendered.querySelectorAll("tbody tr"),
        (row) => row.textContent,
      ),
    ).toEqual(["Group A", "Group B"]);
  });

  it("uses one pre-wrapped newline for rich HTML line breaks", () => {
    const markdownSource = richTextHtmlToMarkdown("<p>A<br>B</p>");
    const html = renderToStaticMarkup(
      createElement(
        "article",
        { className: "markdown-body" },
        createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
      ),
    );

    expect(markdownSource).toBe("A\nB");
    expect(html).toBe('<article class="markdown-body"><p>A\nB</p></article>');
    expect(html).not.toContain("<br");
  });

  it("collapses boundary ASCII whitespace after generated soft breaks", () => {
    const markdownSource = richTextHtmlToMarkdown("<p>A<br> \t\n B</p>");
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );

    expect(markdownSource).toBe("A\nB");
    expect(html).toBe("<p>A\nB</p>");
    expect(richTextHtmlToMarkdown("<p>A<br>&nbsp;B</p>")).toBe(
      "A\n\u00a0B",
    );
    expect(richTextHtmlToMarkdown("<p>One<br><code> Two</code></p>")).toBe(
      "One\n`  Two `",
    );
  });

  it("flattens line breaks in headings", () => {
    expect(richTextHtmlToMarkdown("<h2>Hello<br>world</h2>")).toBe(
      "## Hello world",
    );
  });

  it("defers ambiguous boundary and consecutive line breaks", () => {
    for (const source of [
      "<p><br><strong>Two</strong></p>",
      "<p><strong>One</strong><br></p>",
      "<p><strong>One</strong><br><br>Two</p>",
      "<div><div>One</div><br>Two<strong>Three</strong></div>",
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
  });

  it("preserves trailing heading hashes as text", () => {
    const markdownSource = richTextHtmlToMarkdown("<h1>Foo #</h1>");
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );

    expect(markdownSource).toBe("# Foo \\#");
    expect(html).toBe("<h1>Foo #</h1>");
  });

  it("keeps a linked soft break outside the link destination", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<p><a href="https://example.com/x">one<br></a>after</p>',
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );

    expect(markdownSource).toBe("[one](https://example.com/x)\nafter");
    expect(html).toBe(
      '<p><a href="https://example.com/x">one</a>\nafter</p>',
    );
  });

  it("keeps boundary soft breaks outside formatting delimiters", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p><strong>one<br></strong>after <em><br>two</em> <del>three<br></del>end</p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );

    expect(markdownSource).toBe("**one**\nafter \n*two* ~~three~~\nend");
    expect(html).toBe(
      "<p><strong>one</strong>\nafter\n<em>two</em> <del>three</del>\nend</p>",
    );
  });

  it("defers formatting that contains only line breaks", () => {
    expect(richTextHtmlToMarkdown("<p><strong><br></strong></p>")).toBeNull();
    expect(richTextHtmlToMarkdown("<p><strong><br><br></strong></p>")).toBeNull();
  });

  it("coalesces adjacent equivalent formatting runs", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p><strong>foo</strong><b>bar</b> <em>a</em><i>b</i> <del>x</del><s>y</s> <code>c</code><code>d</code></p>",
    );

    expect(markdownSource).toBe("**foobar** *ab* ~~xy~~ `cd`");
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");
    expect(rendered.querySelector("strong")?.textContent).toBe("foobar");
    expect(rendered.querySelector("em")?.textContent).toBe("ab");
    expect(rendered.querySelector("del")?.textContent).toBe("xy");
    expect(rendered.querySelector("code")?.textContent).toBe("cd");
  });

  it("keeps adjacent nested formatting delimiters well formed", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p><strong><em>a</em></strong><em>a</em></p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toBe("__*a*__*a*");
    expect(rendered.body.textContent).toBe("aa");
    expect(rendered.querySelector("strong > em")?.textContent).toBe("a");
    expect(rendered.querySelectorAll("em")).toHaveLength(2);

    const mixedMarkdown = richTextHtmlToMarkdown(
      "<p><strong><em>a</em>b</strong></p>",
    );
    const mixedHtml = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, mixedMarkdown),
    );
    expect(mixedMarkdown).toBe("***a*b**");
    expect(mixedHtml).toBe("<p><strong><em>a</em>b</strong></p>");

    const adjacentMarkdown = richTextHtmlToMarkdown(
      "<p><strong>Important:</strong><em>note</em></p>",
    );
    const adjacentHtml = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm] },
        adjacentMarkdown,
      ),
    );
    const adjacentRendered = new DOMParser().parseFromString(
      adjacentHtml,
      "text/html",
    );
    expect(adjacentMarkdown).toBe("__Important:__*note*");
    expect(adjacentRendered.body.textContent).toBe("Important:note");
    expect(adjacentRendered.querySelector("strong")?.textContent).toBe(
      "Important:",
    );
    expect(adjacentRendered.querySelector("em")?.textContent).toBe("note");

    const reverseMarkdown = richTextHtmlToMarkdown(
      "<p><em>note</em><strong>: Important</strong></p>",
    );
    const reverseHtml = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm] },
        reverseMarkdown,
      ),
    );
    const reverseRendered = new DOMParser().parseFromString(
      reverseHtml,
      "text/html",
    );
    expect(reverseMarkdown).toBe("*note*__: Important__");
    expect(reverseRendered.body.textContent).toBe("note: Important");
    expect(reverseRendered.querySelector("em")?.textContent).toBe("note");
    expect(reverseRendered.querySelector("strong")?.textContent).toBe(
      ": Important",
    );
  });

  it("does not skip nodes after empty inline candidates", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p>A<a href="https://example.com/empty"></a>B <strong>C</strong><a href="https://example.com/also-empty"></a><strong>D</strong> E</p>',
      ),
    ).toBe("AB **CD** E");
  });

  it("keeps generated inline Markdown outside bare autolinks", () => {
    const cases = [
      ["<p>www.x.com<strong>Z</strong></p>", "www.x.comZ", "strong"],
      [
        "<p><span>https</span><span>://x.com</span><strong>Z</strong></p>",
        "https://x.comZ",
        "strong",
      ],
      [
        "<p><span>www</span><span>.x.com</span><em>Z</em></p>",
        "www.x.comZ",
        "em",
      ],
      [
        '<p>www.x.com<a href="https://example.com/y">Y</a></p>',
        "www.x.comY",
        "a",
      ],
      [
        '<p>www.x.com<img src="https://example.com/y" alt="Y"></p>',
        "www.x.com",
        "img",
      ],
      ['<p>!<a href="https://example.com/u">L</a></p>', "!L", "a"],
    ] as const;

    for (const [source, text, selector] of cases) {
      const markdownSource = richTextHtmlToMarkdown(source);
      const html = renderToStaticMarkup(
        createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
      );
      const rendered = new DOMParser().parseFromString(html, "text/html");
      expect(rendered.body.textContent).toBe(text);
      expect(rendered.querySelector(selector)).not.toBeNull();
      expect(rendered.body.textContent).not.toContain("**");
    }
  });

  it("drops formatting markers that CommonMark cannot flank", () => {
    const cases = [
      ["<p>a<em>!</em>b</p>", "a\\!b"],
      ["<p><strong>Note:</strong>next</p>", "Note:next"],
      ["<p><strong>$</strong>100</p>", "$100"],
      ["<p><strong>a</strong><em>$</em></p>", "**a**$"],
      ["<p>a<strong><em>!</em></strong>b</p>", "a\\!b"],
    ] as const;

    for (const [source, expected] of cases) {
      const markdownSource = richTextHtmlToMarkdown(source);
      const html = renderToStaticMarkup(
        createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
      );
      expect(markdownSource).toBe(expected);
      expect(html).not.toMatch(/(?:\*|~){1,2}[!:$](?:\*|~){1,2}/);
    }
  });

  it("does not expose delimiters when adjacent formatting changes flanking", () => {
    const cases = [
      ["<p><strong>x!</strong><del>x!</del>a</p>", "x!x!a"],
      ["<p><em>x</em><strong>!x</strong>a</p>", "x!xa"],
      ["<p>*<strong>!x</strong>a</p>", "*!xa"],
    ] as const;

    for (const [source, expectedText] of cases) {
      const markdownSource = richTextHtmlToMarkdown(source);
      const html = renderToStaticMarkup(
        createElement(
          ReactMarkdown,
          { remarkPlugins: [remarkGfm] },
          markdownSource,
        ),
      );
      const rendered = new DOMParser().parseFromString(html, "text/html");

      expect(rendered.body.textContent, source).toBe(expectedText);
      expect(rendered.body.textContent, source).not.toMatch(/(?:\*\*|__|~~)/);
    }
  });

  it("preserves visible text across adjacent formatting boundaries", () => {
    const wrappers = [
      (value: string) => `<strong>${value}</strong>`,
      (value: string) => `<em>${value}</em>`,
      (value: string) => `<del>${value}</del>`,
    ];
    const boundaries = ["", "a", "!"];
    const values = ["x", "!", "x!", "!x"];

    for (const leftWrap of wrappers) {
      for (const rightWrap of wrappers) {
        for (const before of boundaries) {
          for (const after of boundaries) {
            for (const leftValue of values) {
              for (const rightValue of values) {
                const source = `<p>${before}${leftWrap(leftValue)}${rightWrap(rightValue)}${after}</p>`;
                const markdownSource = richTextHtmlToMarkdown(source);
                const html = renderToStaticMarkup(
                  createElement(
                    ReactMarkdown,
                    { remarkPlugins: [remarkGfm] },
                    markdownSource,
                  ),
                );
                const renderedText = new DOMParser()
                  .parseFromString(html, "text/html")
                  .body.textContent;
                const expectedText = new DOMParser()
                  .parseFromString(source, "text/html")
                  .body.textContent;
                expect(renderedText, source).toBe(expectedText);
              }
            }
          }
        }
      }
    }
  });

  it("serializes nested equivalent strong formatting in linear time", () => {
    const depth = 20;
    const source = `<p>${"<strong>".repeat(depth)}!${"</strong>".repeat(depth)}<em>x</em></p>`;
    const startedAt = performance.now();
    const markdownSource = richTextHtmlToMarkdown(source);
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    expect(markdownSource).not.toBeNull();
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    expect(new DOMParser().parseFromString(html, "text/html").body.textContent)
      .toBe("!x");
  });

  it("preserves visible text across formatting boundary combinations", () => {
    const wrappers = [
      (value: string) => `<strong>${value}</strong>`,
      (value: string) => `<em>${value}</em>`,
      (value: string) => `<del>${value}</del>`,
      (value: string) => `<strong><em>${value}</em></strong>`,
      (value: string) => `<em><strong>${value}</strong></em>`,
    ];
    const boundaries = ["", "a", "!", "$", "www.x.com"];
    const values = ["x", "!", "$", "x!", "!x", " x "];

    for (const wrap of wrappers) {
      for (const before of boundaries) {
        for (const after of boundaries) {
          for (const value of values) {
            const source = `<p>${before}${wrap(value)}${after}</p>`;
            const markdownSource = richTextHtmlToMarkdown(source);
            const html = renderToStaticMarkup(
              createElement(
                ReactMarkdown,
                { remarkPlugins: [remarkGfm] },
                markdownSource,
              ),
            );
            const expectedText = new DOMParser()
              .parseFromString(source, "text/html")
              .body.textContent?.replace(/\s+/g, " ")
              .trim();
            const renderedText = new DOMParser()
              .parseFromString(html, "text/html")
              .body.textContent?.replace(/\s+/g, " ")
              .trim();
            expect(renderedText, source).toBe(expectedText);
          }
        }
      }
    }
  });

  it("flattens nested equivalent formatting runs", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p><strong>foo<b>bar</b>baz</strong> <em>a<i>b</i>c</em> <del>x<s>y</s>z</del></p>",
    );

    expect(markdownSource).toBe("**foobarbaz** *abc* ~~xyz~~");
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");
    expect(rendered.querySelector("strong")?.textContent).toBe("foobarbaz");
    expect(rendered.querySelector("em")?.textContent).toBe("abc");
    expect(rendered.querySelector("del")?.textContent).toBe("xyz");
  });

  it("coalesces equivalent formatting through neutral wrappers", () => {
    expect(
      richTextHtmlToMarkdown(
        "<p><strong>foo</strong><span><b>bar</b></span><strong>baz</strong></p>",
      ),
    ).toBe("**foobarbaz**");
  });

  it("keeps inline code on one line and omits hidden code descendants", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p><code>a\nb</code> <code>   </code> <code>x<span hidden>secret</span>y</code> <strong>after</strong></p>',
      ),
    ).toBe("`a b` `   ` `xy` **after**");
  });

  it("defers visible non-text code content that Markdown would drop", () => {
    for (const source of [
      '<p><code>before<br>after</code> <strong>Rich</strong></p>',
      '<p><code>before<img src="https://example.com/icon.png" alt="Icon">after</code> <strong>Rich</strong></p>',
      '<pre>before<img src="https://example.com/icon.png" alt="Icon">after</pre>',
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
    expect(richTextHtmlToMarkdown("<pre>before<br>after</pre>")).toBe(
      "```\nbefore\nafter\n```",
    );
  });

  it("sanitizes fenced-code languages and omits hidden code descendants", () => {
    expect(
      richTextHtmlToMarkdown(
        '<pre><code class="language-```">safe<span hidden>secret</span>\n</code></pre>',
      ),
    ).toBe("```\nsafe\n```");
  });

  it("preserves text surrounding a code child inside preformatted content", () => {
    expect(
      richTextHtmlToMarkdown("<pre>prefix<code>x</code>suffix</pre>"),
    ).toBe("```\nprefixxsuffix\n```");
  });

  it("preserves internal fenced-code whitespace", () => {
    expect(
      richTextHtmlToMarkdown("<pre><code>a  \n\n\nb\n</code></pre>"),
    ).toBe("```\na  \n\n\nb\n```");
  });

  it("preserves a significant direct pre newline across inert reparsing", () => {
    expect(richTextHtmlToMarkdown("<pre>\ncode</pre>")).toBe(
      "```\ncode\n```",
    );
    expect(richTextHtmlToMarkdown("<pre>\n\ncode</pre>")).toBe(
      "```\n\ncode\n```",
    );
    expect(richTextHtmlToMarkdown("<pre>\r\n\r\ncode</pre>")).toBe(
      "```\n\ncode\n```",
    );
  });

  it("defers block children whose preformatted line breaks would be lost", () => {
    for (const source of [
      "<pre><div>first</div><div>second</div></pre>",
      "<pre><code>first<section>second</section>third</code></pre>",
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
  });

  it("escapes text that would otherwise become block Markdown", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p># Heading</p><p>&gt; Quote</p><p>- item</p><p>1. item</p><p>---</p><p>===</p><p><strong>Rich</strong></p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toContain("\\# Heading");
    expect(markdownSource).toContain("\\- item");
    expect(markdownSource).toContain("1\\. item");
    expect(markdownSource).toContain("\\---");
    expect(markdownSource).toContain("\\===");
    expect(rendered.querySelector("h1, blockquote, ul, ol, hr")).toBeNull();
    expect(rendered.body.textContent).toContain("# Heading");
    expect(rendered.body.textContent).toContain("> Quote");
  });

  it.each([
    {
      expectedMarkdown: "Title\n\\--\n\n**Rich**",
      literalText: "--",
      source: "<p>Title<br>--</p><p><strong>Rich</strong></p>",
    },
    {
      expectedMarkdown: "\\-- --\n\n**Rich**",
      literalText: "-- --",
      source: "<p>-- --</p><p><strong>Rich</strong></p>",
    },
  ])(
    "keeps Setext and thematic-break text literal for $source",
    ({ expectedMarkdown, literalText, source }) => {
      const markdownSource = richTextHtmlToMarkdown(source);
      const html = renderToStaticMarkup(
        createElement(
          ReactMarkdown,
          { remarkPlugins: [remarkGfm] },
          markdownSource,
        ),
      );
      const rendered = new DOMParser().parseFromString(html, "text/html");

      expect(markdownSource).toBe(expectedMarkdown);
      expect(rendered.querySelector("h1, h2, hr")).toBeNull();
      expect(rendered.body.textContent).toContain(literalText);
      expect(rendered.querySelector("strong")?.textContent).toBe("Rich");
    },
  );

  it("keeps pasted image-width syntax literal", () => {
    const markdownSource = richTextHtmlToMarkdown(
      '<p><img src="https://example.com/image.png">{width=10%}</p><p><strong>Rich</strong></p>',
    );
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, remarkImageWidth] },
        markdownSource,
      ),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toContain("\\{width=10%\\}");
    expect(rendered.querySelector("img")?.hasAttribute("style")).toBe(false);
    expect(rendered.body.textContent).toContain("{width=10%}");
  });

  it("preserves whitespace around linked text", () => {
    expect(
      richTextHtmlToMarkdown(
        '<p>See<a href="https://example.com/x"> this </a>now</p>',
      ),
    ).toBe("See [this](https://example.com/x) now");
  });

  it("collapses ASCII whitespace across serialized inline boundaries", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p>A <strong> B </strong> C <em> D </em> E</p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toBe("A **B** C *D* E");
    expect(rendered.body.textContent).toBe("A B C D E");
    expect(rendered.querySelector("strong")?.textContent).toBe("B");
    expect(rendered.querySelector("em")?.textContent).toBe("D");
  });

  it("preserves non-breaking spaces through formatting and boundary trimming", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p><strong>&nbsp;A&nbsp;&nbsp;B&nbsp;</strong></p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toBe("\u00a0**A\u00a0\u00a0B**\u00a0");
    expect(rendered.body.textContent).toBe("\u00a0A\u00a0\u00a0B\u00a0");
    expect(rendered.querySelector("strong")?.textContent).toBe(
      "A\u00a0\u00a0B",
    );
  });

  it("omits hidden list items and nested lists", () => {
    expect(
      richTextHtmlToMarkdown(
        '<ul><li style="display:none">Secret</li><li>Visible<ul hidden><li>Nested secret</li></ul></li></ul>',
      ),
    ).toBe("- Visible");
    expect(
      richTextHtmlToMarkdown(
        "<ul><li>Before<ul hidden><li>Secret</li></ul>After</li></ul>",
      ),
    ).toBe("- BeforeAfter");
  });

  it("defers visible direct list content that is not a list item", () => {
    for (const source of [
      "<ul>Before<li>Item</li>After</ul>",
      "<ol><div>Introduction</div><li>Item</li></ol>",
      "<menu><span>Introduction</span><li>Item</li></menu>",
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
    expect(
      richTextHtmlToMarkdown(
        '<ul><div hidden>Hidden introduction</div><li><strong>Item</strong></li></ul>',
      ),
    ).toBe("- **Item**");
  });

  it("defers orphan list items instead of merging sibling text", () => {
    expect(
      richTextHtmlToMarkdown(
        "<li><strong>One</strong></li><li><em>Two</em></li>",
      ),
    ).toBeNull();
  });

  it("keeps child lists nested beneath ordered items", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<ol><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ol>",
    );

    expect(markdownSource).toBe("1. Parent\n   - Child\n2. Next");
    const tree = markdownLanguage.parser.parse(markdownSource!);
    const orderedList = tree.topNode.getChild("OrderedList");
    expect(orderedList?.getChild("ListItem")?.getChild("BulletList")).not.toBeNull();
    expect(tree.topNode.getChild("BulletList")).toBeNull();
  });

  it("preserves content order around nested lists", () => {
    expect(
      richTextHtmlToMarkdown(
        "<ul><li>Before<ul><li>Child</li></ul>After</li></ul>",
      ),
    ).toBe("- Before\n  - Child\n\n  After");
  });

  it("preserves paragraph boundaries inside list items", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<ul><li><p>First</p><p>Second</p></li></ul>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toBe("- First\n\n  Second");
    expect(Array.from(rendered.querySelectorAll("ul > li > p"), (p) => p.textContent))
      .toEqual(["First", "Second"]);
  });

  it("keeps definition and disclosure blocks separated", () => {
    expect(
      richTextHtmlToMarkdown(
        "<dl><dt><strong>Term</strong></dt><dd>Definition</dd></dl>",
      ),
    ).toBe("**Term**\n\nDefinition");
    expect(
      richTextHtmlToMarkdown(
        "<details open><summary><strong>Title</strong></summary><p>Body</p></details>",
      ),
    ).toBe("**Title**\n\nBody");
    expect(
      richTextHtmlToMarkdown(
        "<details><summary><strong>Title</strong></summary><p>SECRET</p></details>",
      ),
    ).toBeNull();
  });

  it("defers block descendants inside inline wrappers", () => {
    for (const source of [
      '<a href="https://example.com"><div><strong>First</strong></div><div>Second</div></a>',
      "<span><p><strong>First</strong></p><p>Second</p></span>",
      "<strong><div>First</div><div>Second</div></strong>",
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
  });

  it("handles deeply nested block wrappers within the DOM complexity budget", () => {
    const depth = 450;
    const source = `${"<div>".repeat(depth)}<strong>Visible</strong>${"</div>".repeat(depth)}`;

    expect(richTextHtmlToMarkdown(source)).toBe("**Visible**");
  });

  it("keeps figure captions separate from image syntax", () => {
    expect(
      richTextHtmlToMarkdown(
        '<figure><img src="https://example.com/image.png"><figcaption><strong>Caption</strong></figcaption></figure>',
      ),
    ).toBe("![](https://example.com/image.png)\n\n**Caption**");
  });

  it("preserves task-list checkboxes and menu items", () => {
    const taskMarkdown = richTextHtmlToMarkdown(
      '<ul><li><input type="checkbox" checked><strong>Done</strong></li><li><input type="checkbox"> Open</li></ul>',
    );
    const taskHtml = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, taskMarkdown),
    );

    expect(taskMarkdown).toBe("- [x] **Done**\n- [ ] Open");
    expect(taskHtml.match(/type="checkbox"/g)).toHaveLength(2);
    expect(
      richTextHtmlToMarkdown(
        '<p><input type="checkbox" checked> Agree</p>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<ul><li>Do <input type="checkbox" checked> now</li></ul>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        "<menu><li><strong>A</strong></li><li>B</li></menu>",
      ),
    ).toBe("- **A**\n- B");
    expect(
      richTextHtmlToMarkdown(
        '<ul><li><a href="https://example.com/url">x</a></li></ul>',
      ),
    ).toBe("- [x](https://example.com/url)");
  });

  it("defers ordered-list shapes Markdown cannot represent", () => {
    expect(richTextHtmlToMarkdown("<ol reversed><li>Two</li><li>One</li></ol>"))
      .toBeNull();
    expect(richTextHtmlToMarkdown("<ol><li value=3>Three</li></ol>"))
      .toBeNull();
    expect(richTextHtmlToMarkdown("<ol start=-1><li>Minus one</li></ol>"))
      .toBeNull();
    expect(richTextHtmlToMarkdown("<ol start=1000000000><li>Large</li></ol>"))
      .toBeNull();
    expect(
      richTextHtmlToMarkdown(
        "<ol start=9007199254740992><li>Unsafe integer</li></ol>",
      ),
    ).toBeNull();
    expect(richTextHtmlToMarkdown("<ol type=a><li>Alpha</li></ol>"))
      .toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<ol style="list-style-type:lower-alpha"><li>Alpha</li></ol>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<ol><li style="list-style-type:upper-roman">One</li></ol>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<ol style="list-style:lower-alpha"><li>Alpha</li></ol>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<ol><li style="list-style:none">One</li></ol>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<div style="list-style:lower-alpha"><ol><li>Alpha</li></ol></div>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<div style="list-style-type:upper-roman"><ol><li>One</li></ol></div>',
      ),
    ).toBeNull();
    expect(
      richTextHtmlToMarkdown(
        '<ol><li style="visibility:hidden">Hidden</li><li><strong>Visible</strong></li></ol>',
      ),
    ).toBeNull();
    for (const hidden of ["hidden", 'style="display:none"', 'style="opacity:0"']) {
      expect(
        richTextHtmlToMarkdown(
          `<ol start="4"><li ${hidden}>Four</li><li><strong>Five</strong></li></ol>`,
        ),
      ).toBeNull();
    }
  });

  it("defers unordered-list marker styles Markdown cannot represent", () => {
    for (const source of [
      '<ul style="list-style:none"><li><strong>One</strong></li></ul>',
      '<menu><li style="list-style-type:none"><em>One</em></li></menu>',
      '<ul><li>Outer<ul><li style="list-style-type:none"><strong>Inner</strong></li></ul></li></ul>',
      '<ul><li style="list-style-image:url(https://example.com/marker.png)"><strong>One</strong></li></ul>',
    ]) {
      expect(richTextHtmlToMarkdown(source)).toBeNull();
    }
  });

  it("honors the nearest supported list marker override", () => {
    expect(
      richTextHtmlToMarkdown(
        '<ul style="list-style-type:none"><li style="list-style-type:disc;list-style-image:none"><strong>One</strong></li></ul>',
      ),
    ).toBe("- **One**");
    expect(
      richTextHtmlToMarkdown(
        '<ol style="list-style-type:lower-alpha"><li style="list-style-type:decimal;list-style-image:none"><strong>One</strong></li></ol>',
      ),
    ).toBe("1. **One**");
    expect(
      richTextHtmlToMarkdown(
        '<ul style="list-style-type:disc"><li style="list-style-type:none"><strong>One</strong></li></ul>',
      ),
    ).toBeNull();
  });

  it("surrounds pasted block Markdown with blank lines", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "BeforeAfter",
        selection: { anchor: 6 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/html" ? "<h2>Heading</h2>" : "Heading"),
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Before\n\n## Heading\n\nAfter");
  });

  it("starts pasted block Markdown after leading indentation", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "   ",
        selection: { anchor: 3 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/html" ? "<h2>Heading</h2>" : "Heading"),
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("   \n## Heading");
  });

  it("treats non-breaking spaces as block-boundary content", () => {
    for (const [position, expected] of [
      [0, "---\n\n\u00a0"],
      [1, "\u00a0\n\n---"],
    ] as const) {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: "\u00a0",
          selection: { anchor: position },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? "<hr>" : "---"),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      view.destroy();
      view = undefined;
    }
  });

  it("adds block boundaries without serializing the whole document", () => {
    const source = `BeforeAfter\n\n${"x\n\n".repeat(300_000)}`;
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: 6 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const serialize = vi.spyOn(view.state.doc, "toString");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<h2>Heading</h2>" : "Heading",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(serialize).not.toHaveBeenCalled();
    expect(view.state.doc.sliceString(0, 25)).toBe(
      "Before\n\n## Heading\n\nAfter",
    );
  });

  it("keeps block paste working across multiple selections", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "One\n\nTwo",
        selection: EditorSelection.create([
          EditorSelection.cursor(3),
          EditorSelection.cursor(8),
        ]),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<h2>Heading</h2>" : "Heading",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "One\n\n## Heading\n\nTwo\n\n## Heading",
    );
  });

  it.each([
    ["before", "", "Start"],
    ["after", "", "Start"],
    ["before", "[FILTERED]", "[FILTERED]Start"],
    ["after", "[FILTERED]", "[FILTERED]Start"],
  ])(
    "preserves a same-precedence clipboard filter %s rich paste when it returns %j",
    (order, filtered, expected) => {
      const clipboardFilter = Prec.lowest(
        EditorView.clipboardInputFilter.of(() => filtered),
      );
      const pasteExtensions = order === "before"
        ? [clipboardFilter, markdownRichTextPaste]
        : [markdownRichTextPaste, clipboardFilter];
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: "Start",
          extensions: [
            markdown({ base: markdownLanguage }),
            ...pasteExtensions,
          ],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) =>
            type === "text/html" ? "<strong>SECRET</strong>" : "SECRET",
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.doc.toString()).not.toContain("**SECRET**");
    },
  );

  it("preserves a later clipboard filter even when URL paste also rewrites it", () => {
    const filteredUrl = "https://filtered.example/path";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Start",
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          Prec.lowest(
            EditorView.clipboardInputFilter.of(() => filteredUrl),
          ),
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>SECRET</strong>" : "ORIGINAL",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      `[${filteredUrl}](${filteredUrl})Start`,
    );
    expect(view.state.doc.toString()).not.toContain("SECRET");
  });

  it("falls back atomically when multicursor block boundaries exhaust their shared budget", () => {
    const source = `${" ".repeat(60_000)}\nX\n${" ".repeat(60_000)}\nY`;
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: EditorSelection.create([
          EditorSelection.cursor(source.indexOf("X")),
          EditorSelection.cursor(source.indexOf("Y")),
        ]),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<h2>Heading</h2>" : "Heading",
      },
    });
    const native = view.state.update(view.state.replaceSelection("Heading"), {
      userEvent: "input.type",
    }).state.doc.sliceString(0);

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.sliceString(0)).toBe(native);
    expect(view.state.doc.sliceString(0)).not.toContain("## Heading");
  });

  it("preserves outer whitespace when rich inline paste falls back", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "HelloWorld",
        selection: { anchor: 5 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? "<span> <strong>Bold</strong> </span>"
            : " Bold ",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("Hello Bold World");
    expect(view.state.selection.main.head).toBe(11);
  });

  it("does not drop a trailing rich-text line break", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "After",
        selection: { anchor: 0 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>Before</strong><br>" : "Before\n",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("Before\nAfter");
    expect(view.state.selection.main.head).toBe(7);
  });

  it.each([
    "<strong>One</strong><br><strong>Two</strong>",
    "<h2>One</h2><h2>Two</h2>",
  ])("preserves native one-line-per-range paste semantics for %s", (html) => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "a b",
        selection: EditorSelection.create([
          EditorSelection.cursor(1),
          EditorSelection.cursor(3),
        ]),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? html : "One\nTwo",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("aOne bTwo");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([
      4,
      9,
    ]);
    view.destroy();
    view = undefined;
  });

  it("preserves native URI-list distribution across multiple selections", () => {
    const urls = "https://one.example\nhttps://two.example";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "a b",
        selection: EditorSelection.create([
          EditorSelection.cursor(1),
          EditorSelection.cursor(3),
        ]),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? "<strong>https://one.example</strong><br><strong>https://two.example</strong>"
            : type === "text/uri-list"
              ? urls
              : "",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      "ahttps://one.example bhttps://two.example",
    );
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([
      20,
      41,
    ]);
  });

  it("repeats one-line rich HTML across multiple selections", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "a b",
        selection: EditorSelection.create([
          EditorSelection.cursor(1),
          EditorSelection.cursor(3),
        ]),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>One</strong>" : "One",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("a**One** b**One**");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([
      8,
      17,
    ]);
  });

  it.each([
    ["## old", "## old", "<h2>New</h2>", "## New"],
    [
      "Before [old](https://old.example) after",
      "[old](https://old.example)",
      "<strong>New</strong>",
      "Before **New** after",
    ],
    [
      "Before *old* after",
      "*old*",
      "<strong>New</strong>",
      "Before **New** after",
    ],
  ])(
    "converts rich text when replacing the entire Markdown container in %s",
    (source, selected, html, expected) => {
      const from = source.indexOf(selected);
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: from, head: from + selected.length },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : "New"),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
    },
  );

  it("falls back atomically when rich multicursor context parsing fails", () => {
    syntaxTreeMock.failOnCall = 3;
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "first\n\nsecond",
        selection: EditorSelection.create([
          EditorSelection.cursor(5),
          EditorSelection.cursor(13),
        ]),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>New</strong>" : "New",
      },
    });
    const native = view.state.update(view.state.replaceSelection("New"), {
      userEvent: "input.type",
    }).state.doc.toString();

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(native);
    expect(view.state.doc.toString()).not.toContain("**New**");
    expect(syntaxTreeMock.calls).toBe(3);
  });

  it("bypasses rich conversion before parsing excessive selection ranges", () => {
    const paragraphCount = 33_334;
    const doc = "a\n\n".repeat(paragraphCount);
    const ranges = Array.from({ length: 1_000 }, (_, index) => {
      const paragraph = Math.floor((index * (paragraphCount - 1)) / 999);
      return EditorSelection.cursor(paragraph * 3);
    });
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: EditorSelection.create(ranges),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    const getData = vi.fn((type: string) =>
      type === "text/html" ? "<strong>New</strong>" : "New",
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [], getData },
    });
    const native = view.state.update(view.state.replaceSelection("New"), {
      userEvent: "input.type",
    }).state.doc.toString();

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(native);
    expect(view.state.doc.toString()).not.toContain("**New**");
    expect(getData).toHaveBeenCalled();
    expect(parser).not.toHaveBeenCalled();
    expect(syntaxTreeMock.calls).toBe(0);
  });

  it("bypasses rich conversion for too many non-empty replacements", () => {
    const doc = "x ".repeat(9);
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: EditorSelection.create(
          Array.from({ length: 9 }, (_, index) =>
            EditorSelection.range(index * 2, index * 2 + 1),
          ),
        ),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownRichTextPaste,
          EditorState.allowMultipleSelections.of(true),
        ],
      }),
    });
    const native = view.state.update(view.state.replaceSelection("New"), {
      userEvent: "input.type",
    }).state.doc.toString();
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>New</strong>" : "New",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(native);
    expect(view.state.doc.toString()).not.toContain("**New**");
    expect(parser).not.toHaveBeenCalled();
    expect(syntaxTreeMock.calls).toBe(0);
  });

  it.each([
    "- BeforeAfter",
    "> BeforeAfter",
    "## BeforeAfter",
    "**BeforeAfter**",
    "| A |\n| --- |\n| BeforeAfter |",
  ])(
    "leaves block paste inside a Markdown container native for %s",
    (source) => {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: source.indexOf("After") },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) =>
            type === "text/html" ? "<h2>Heading</h2>" : "Heading",
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(source.replace("After", "HeadingAfter"));
      view.destroy();
      view = undefined;
    },
  );

  it.each([
    {
      expected: "Wow?[Docs](https://example.com/docs)",
      html: '<a href="https://example.com/docs">Docs</a>',
      position: 4,
      source: "Wow?",
    },
    {
      expected: "**Word**next",
      html: "<strong>Word</strong>",
      position: 0,
      source: "next",
    },
    {
      expected: "x-~~gone~~",
      html: "<del>gone</del>",
      position: 2,
      source: "x-",
    },
    {
      expected: "\\~~~gone~~",
      html: "<del>gone</del>",
      position: 2,
      source: "\\~",
    },
  ])(
    "keeps boundary-safe rich paste for $source",
    ({ expected, html, position, source }) => {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: position },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : "plain"),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(expected);
      view.destroy();
      view = undefined;
    },
  );

  it.each([
    {
      html: "<strong>A | B</strong>",
      plain: "A | B",
      source: "| H |\n| --- |\n| x |",
    },
    {
      html: "<strong>A</strong><br>B",
      plain: "A\nB",
      source: "## BeforeAfter",
    },
  ])(
    "leaves inline rich paste inside a Markdown container native for $source",
    ({ html, plain, source }) => {
      const position = source.indexOf(source.includes("x") ? "x" : "After");
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: position },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : plain),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(
        `${source.slice(0, position)}${plain}${source.slice(position)}`,
      );
      view.destroy();
      view = undefined;
    },
  );

  it.each([
    {
      expected: "Wow!Docs",
      html: '<a href="https://example.com/docs">Docs</a>',
      plain: "Docs",
      position: 4,
      source: "Wow!",
    },
    {
      expected: "Warning:Next",
      html: "<strong>Warning:</strong>",
      plain: "Warning:",
      position: 0,
      source: "Next",
    },
    {
      expected: "x~gone",
      html: "<del>gone</del>",
      plain: "gone",
      position: 2,
      source: "x~",
    },
    {
      expected: "a$b",
      html: "<strong>$</strong>",
      plain: "$",
      position: 1,
      source: "ab",
    },
  ])(
    "leaves boundary-sensitive rich paste native for $source",
    ({ expected, html, plain, position, source }) => {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: position },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : plain),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(expected);
      view.destroy();
      view = undefined;
    },
  );

  it.each([
    { source: "**old", html: "<strong>New</strong>", plain: "New" },
    { source: "**old\nmore", html: "<strong>New</strong>", plain: "New" },
    { source: "`code", html: "<strong>New</strong>", plain: "New" },
    { source: '<a href="', html: "<strong>Bold</strong>", plain: "Bold" },
  ])(
    "leaves rich paste after unfinished syntax native for $source",
    ({ html, plain, source }) => {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: source.length },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : plain),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(`${source}${plain}`);
      view.destroy();
      view = undefined;
    },
  );

  it.each([
    { source: "&cop", html: "<strong>y;</strong>", plain: "y;" },
    { source: "&#6", html: "<strong>5;</strong>", plain: "5;" },
    { source: "&#x4", html: "<strong>1;</strong>", plain: "1;" },
  ])(
    "leaves rich paste after unfinished entity prefix $source native",
    ({ html, plain, source }) => {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: source.length },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : plain),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(`${source}${plain}`);
      view.destroy();
      view = undefined;
    },
  );

  it.each([
    {
      source: '[ref]: https://example.com\n  "ti',
      html: '<strong>tle"</strong>',
      plain: 'tle"',
    },
    {
      source: "[ref]: https://example.com\n  'ti",
      html: "<strong>tle'</strong>",
      plain: "tle'",
    },
    {
      source: "[ref]: https://example.com\n  (ti",
      html: "<strong>tle)</strong>",
      plain: "tle)",
    },
  ])(
    "leaves rich paste in unfinished reference title $source native",
    ({ html, plain, source }) => {
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor: source.length },
          extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : plain),
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(`${source}${plain}`);
      view.destroy();
      view = undefined;
    },
  );

  it("detects a Markdown container beyond the initially parsed viewport", () => {
    const prefix = "paragraph\n\n".repeat(2_500);
    const source = `${prefix}- BeforeAfter`;
    const position = source.indexOf("After", prefix.length);
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: position },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<h2>Heading</h2>" : "Heading",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      `${source.slice(0, position)}Heading${source.slice(position)}`,
    );
  });

  it("leaves rich HTML inside fenced code to the native paste path", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "```\nvalue\n```",
        selection: { anchor: 4, head: 9 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/html" ? "<strong>Bold</strong>" : "Bold"),
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nBold\n```");
  });

  it("leaves rich HTML inside Markdown comments to the native paste path", () => {
    const source = "<!-- old -->";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: 5, head: 8 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>Bold</strong>" : "Bold",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("<!-- Bold -->");
  });

  it("converts rich text when a whole Markdown link is replaced", () => {
    const source = "Intro [old](https://old.example) outro";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: 0, head: source.length },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>New</strong>" : "New",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("**New**");
  });

  it("leaves rich replacement inside surviving link syntax to native paste", () => {
    const source = "[old](https://old.example)";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: 1, head: 4 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>New</strong>" : "New",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("[New](https://old.example)");
  });

  it("leaves rich replacement inside an unfinished link destination native", () => {
    const source = "[label](old";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: 8, head: source.length },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? "<strong>New</strong>" : "New",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("[label](New");
  });

  it("lets standalone URL paste use the selected Markdown-link label", () => {
    const url = "https://example.com/a|b";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "label",
        selection: { anchor: 0, head: 5 },
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          // Match the extension order used by EditorWorkspace.
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? `<a href="${url}">${url}</a>` : url,
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      "[label](https://example.com/a%7Cb)",
    );
  });

  it("preserves a rich anchor target that differs from its plain URL flavor", () => {
    const visibleUrl = "https://visible.example/path";
    const targetUrl = "https://target.example/path";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<a href="${targetUrl}">${visibleUrl}</a>`
            : visibleUrl,
      },
    });

    view.contentDOM.dispatchEvent(event);

    const markdownSource = view.state.doc.toString();
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, null, markdownSource),
    );
    expect(markdownSource).toBe(
      `[${visibleUrl.replace(":", "\\:")}](${targetUrl})`,
    );
    expect(html).toBe(`<p><a href="${targetUrl}">${visibleUrl}</a></p>`);
  });

  it("uses a differing rich anchor instead of the selected URL-paste label", () => {
    const visibleUrl = "https://visible.example/path";
    const targetUrl = "https://target.example/path";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "selected label",
        selection: { anchor: 0, head: 14 },
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<a href="${targetUrl}">${visibleUrl}</a>`
            : visibleUrl,
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      `[${visibleUrl.replace(":", "\\:")}](${targetUrl})`,
    );
  });

  it("preserves rich link metadata instead of deferring to URL paste", () => {
    const url = "https://example.com/path";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "label",
        selection: { anchor: 0, head: 5 },
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<a href="${url}" title="Details">${url}</a>`
            : url,
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      `[${url.replace(":", "\\:")}](${url} "Details")`,
    );
  });

  it("keeps a same-target rich link when URL paste cannot link an empty selection", () => {
    const url = "mailto:writer@example.com";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? `<a href="${url}">${url}</a>` : url,
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      "[mailto:writer\\@example.com](mailto:writer@example.com)",
    );
  });

  it("uses a URI-list URL with the selected Markdown-link label", () => {
    const url = "https://example.com/path";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "label",
        selection: { anchor: 0, head: 5 },
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<a href="${url}">${url}</a>`
            : type === "text/uri-list"
              ? url
              : "",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(`[label](${url})`);
  });

  it("prefers rich image HTML over its plain URL clipboard flavor", () => {
    const url = "https://example.com/photo.png";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage, pasteURLAsLink: false }),
          markdownRichTextPaste,
          markdownLinkPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<img src="${url}" alt="Photo">`
            : ` ${url}\n`,
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(` ![Photo](${url})\n`);
  });

  it("leaves an image paste native before existing image-width syntax", () => {
    const suffix = "{width=50%} literal";
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: suffix,
        selection: { anchor: 0 },
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<img src="https://example.com/photo.png" alt="Photo">'
            : "Photo",
      },
    });

    view.contentDOM.dispatchEvent(event);

    const markdownSource = view.state.doc.toString();
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, remarkImageWidth] },
        markdownSource,
      ),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");
    expect(markdownSource).toBe(`Photo${suffix}`);
    expect(rendered.querySelector("img")).toBeNull();
    expect(rendered.body.textContent).toContain("{width=50%}");
  });

  it.each([
    ["**old", 2, 5, `**https://example.com`],
    ["[label](old", 8, 11, "[label](https://example.com"],
  ])(
    "keeps standalone URL replacement native in literal context %s",
    (source, anchor, head, expected) => {
      const url = "https://example.com";
      view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: source,
          selection: { anchor, head },
          extensions: [
            markdown({ base: markdownLanguage, pasteURLAsLink: false }),
            markdownRichTextPaste,
            markdownLinkPaste,
          ],
        }),
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) =>
            type === "text/html" ? `<a href="${url}">${url}</a>` : url,
        },
      });

      view.contentDOM.dispatchEvent(event);

      expect(view.state.doc.toString()).toBe(expected);
    },
  );

  it("keeps consecutive rich one-column tables separate", () => {
    const tableHtml = ["A", "B", "C", "D"]
      .map((value) => `<table><tr><td>${value}</td></tr></table>`)
      .join("");
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/html" ? tableHtml : "A\nB\nC\nD"),
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      "|  |\n| --- |\n| A |\n\n|  |\n| --- |\n| B |\n\n|  |\n| --- |\n| C |\n\n|  |\n| --- |\n| D |",
    );
  });

  it("keeps valid one-hyphen GFM tables byte-for-byte on native paste", () => {
    const source = `|   |   |
| - | - |

|   |
| - |

A

|   |
| - |

B

|   |
| - |

C

|   |
| - |

D`;
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [markdown({ base: markdownLanguage }), markdownRichTextPaste],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => type === "text/plain" ? source : "",
      },
    });
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, source),
    );

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(source);
    expect(new DOMParser().parseFromString(html, "text/html").querySelectorAll("table"))
      .toHaveLength(5);
  });

  it("escapes accidental GFM table delimiter rows in non-table HTML", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p>A | B<br>--- | ---</p><p><strong>x</strong></p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(rendered.querySelector("table")).toBeNull();
    expect(rendered.querySelector("strong")?.textContent).toBe("x");
    expect(rendered.body.textContent).toContain("A | B");
    expect(rendered.body.textContent).toContain("--- | ---");
  });

  it("escapes a GFM delimiter row after a line without a pipe", () => {
    const markdownSource = richTextHtmlToMarkdown(
      "<p>Title<br>| - |</p><p><strong>x</strong></p>",
    );
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdownSource),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");

    expect(markdownSource).toBe("Title\n\\| - |\n\n**x**");
    expect(rendered.querySelector("table")).toBeNull();
    expect(rendered.body.textContent).toContain("Title");
    expect(rendered.body.textContent).toContain("| - |");
    expect(rendered.querySelector("strong")?.textContent).toBe("x");
  });
});
