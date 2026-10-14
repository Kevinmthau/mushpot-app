import { history, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isLiteralMarkdownInsertionContext,
  MAX_CONTEXTUAL_PARSE_SPAN,
  markdownLinkPaste,
} from "@/components/editor/markdown-link-paste";

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

afterEach(() => {
  syntaxTreeMock.calls = 0;
  syntaxTreeMock.failOnCall = 0;
});

const URL_TEXT = "https://example.com/page";
const LINK = `[${URL_TEXT}](${URL_TEXT})`;

function createState(doc = "", anchor = doc.length, head = anchor) {
  return EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [
      markdown({ base: markdownLanguage }),
      markdownLinkPaste,
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
}

function paste(state: EditorState, text = URL_TEXT, userEvent = "input.paste") {
  return state.update(state.replaceSelection(text), { userEvent });
}

describe("pasting Markdown links", () => {
  it("converts a standalone URL and leaves the cursor after the link", () => {
    const tr = paste(createState("See "));

    expect(tr.state.doc.toString()).toBe(`See ${LINK}`);
    expect(tr.state.selection.main.head).toBe(tr.state.doc.length);
    expect(tr.annotation(Transaction.userEvent)).toBe("input.paste");
  });

  it("uses the selected text as the label, including a backwards selection", () => {
    const tr = paste(createState("See this page.", 13, 4));

    expect(tr.state.doc.toString()).toBe(`See [this page](${URL_TEXT}).`);
    expect(tr.state.selection.main.empty).toBe(true);
    expect(tr.state.selection.main.head).toBe(tr.state.doc.length - 1);
  });

  it.each([
    ["mailto:writer@example.com", "mailto:writer@example.com"],
    ["xmpp:writer@example.com", "xmpp:writer@example.com"],
    ["www.example.com/page", "https://www.example.com/page"],
  ])(
    "uses a selected label for the built-in-compatible URL %s",
    (pastedUrl, target) => {
      const tr = paste(createState("contact", 0, 7), pastedUrl);

      expect(tr.state.doc.toString()).toBe(`[contact](${target})`);
    },
  );

  it.each([
    "mailto:writer@example.com",
    "xmpp:writer@example.com",
    "www.example.com/page",
  ])("keeps %s literal for an empty selection", (pastedUrl) => {
    expect(paste(createState(), pastedUrl).state.doc.toString()).toBe(pastedUrl);
  });

  it("preserves surrounding pasted whitespace", () => {
    expect(paste(createState(), ` ${URL_TEXT}\n`).state.doc.toString()).toBe(
      ` ${LINK}\n`,
    );
  });

  it("preserves the target and literal label for Markdown punctuation", () => {
    const url = "https://example.com/a_(b)?tag=[x]&copy;=yes";
    const source = paste(createState(), url).state.doc.toString();
    const html = renderToStaticMarkup(createElement(ReactMarkdown, null, source));

    expect(html).toBe(
      '<p><a href="https://example.com/a_(b)?tag=%5Bx%5D&amp;copy;=yes">https://example.com/a_(b)?tag=[x]&amp;copy;=yes</a></p>',
    );
  });

  it("keeps URLs with pipes inside a single table cell", () => {
    const doc = "| Link |\n| --- |\n|  |";
    const result = paste(createState(doc, doc.length - 2), "https://example.com/a|b");
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, result.state.doc.toString()),
    );

    expect(html).toContain('<td><a href="https://example.com/a%7Cb">https://example.com/a|b</a></td>');
  });

  it.each([
    ["!|", `!${URL_TEXT}`],
    ["\\|", `\\${URL_TEXT}`],
    ["~|~", `~${URL_TEXT}~`],
    ["a*|*", `a*${URL_TEXT}*`],
    ["<|>", `<${URL_TEXT}>`],
    [`~|${"a".repeat(2_000)}~`, `~${URL_TEXT}${"a".repeat(2_000)}~`],
  ])("keeps URL paste native when a generated link would change %s", (template, expected) => {
    const position = template.indexOf("|");
    const state = createState(template.replace("|", ""), position);

    expect(paste(state).state.doc.toString()).toBe(expected);
  });

  it("preserves rendered emphasis and autolink syntax around a URL paste", () => {
    const emphasisTemplate = "a*|*";
    const emphasisPosition = emphasisTemplate.indexOf("|");
    const emphasized = paste(
      createState(emphasisTemplate.replace("|", ""), emphasisPosition),
    ).state.doc.toString();
    const autolinked = paste(createState("<>", 1)).state.doc.toString();
    const emphasisHtml = renderToStaticMarkup(
      createElement(ReactMarkdown, null, emphasized),
    );
    const autolinkHtml = renderToStaticMarkup(
      createElement(ReactMarkdown, null, autolinked),
    );

    expect(emphasisHtml).toContain(`<em>${URL_TEXT}</em>`);
    expect(autolinkHtml).toBe(`<p><a href="${URL_TEXT}">${URL_TEXT}</a></p>`);
  });

  it("still converts a URL pasted inside established emphasis", () => {
    const template = "*before |after*";
    const position = template.indexOf("|");
    const source = paste(
      createState(template.replace("|", ""), position),
    ).state.doc.toString();
    const html = renderToStaticMarkup(createElement(ReactMarkdown, null, source));

    expect(source).toBe(`*before ${LINK}after*`);
    expect(html).toContain(`<em>before <a href="${URL_TEXT}">${URL_TEXT}</a>after</em>`);
  });

  it.each([
    "ordinary text",
    `Visit ${URL_TEXT}`,
    `${URL_TEXT}\nhttps://example.org`,
    `[Example](${URL_TEXT})`,
    `<${URL_TEXT}>`,
    "https://",
    "javascript:alert(1)",
  ])("preserves non-URL clipboard contents: %s", (text) => {
    expect(paste(createState(), text).state.doc.toString()).toBe(text);
  });

  it.each(["input.type", "input.drop", "input", "undo", "redo"])(
    "does not convert %s transactions",
    (userEvent) => {
      expect(paste(createState(), URL_TEXT, userEvent).state.doc.toString()).toBe(
        URL_TEXT,
      );
    },
  );

  it.each([
    "`code |here`",
    "```\n|\n```",
    "```\ncode|",
    "```\n|",
    "~~~\n|",
    "    |",
    "    code|",
    "[label](|)",
    "[label](|",
    "![image](|)",
    "[label](https://example.com/|)",
    "[ref]: |",
    "https://example.com/?next=|&mode=preview",
    "https://example.com/?next=|",
    '<a href="|">label</a>',
    "<!-- | -->",
    "<?target |?>",
    "**unfinished|",
    "**unfinished\ncontinued|",
    "`unfinished|",
    '<a href="|',
  ])("preserves literal paste in %s", (template) => {
    const position = template.indexOf("|");
    const doc = template.replace("|", "");
    const tr = paste(createState(doc, position));

    expect(tr.state.doc.toString()).toBe(template.replace("|", URL_TEXT));
  });

  it.each([
    "[multi\nline|",
    "![multi\nline|",
    "[multi\nline](relative|",
    "![multi\nline](relative|",
    "[label](\nrelative|",
    "[label](\n<relative|",
    '[label](relative\n  "multi\nline|',
    '[label](<https://example.org>\n  "multi\nline|',
    "![image](relative\n  'multi\nline|",
    "[label](relative\n  (multi\nline|",
  ])(
    "preserves native paste in unfinished multiline link syntax in %j",
    (template) => {
      const position = template.indexOf("|");
      const doc = template.replace("|", "");
      const state = createState(doc, position);

      expect(
        isLiteralMarkdownInsertionContext(state, position, position),
      ).toBe(true);
      expect(paste(state).state.doc.toString()).toBe(
        template.replace("|", URL_TEXT),
      );
    },
  );

  it.each([
    "[multi\nline](relative) ",
    '![multi\nline](image.png "multi\nline") ',
    '[label](<https://example.org> "multi\nline") ',
    "*`[not a link`* ",
  ])("still converts after completed inline Markdown in %j", (doc) => {
    expect(paste(createState(doc)).state.doc.toString()).toBe(`${doc}${LINK}`);
  });

  it.each(["&|", "&cop|", "&#|", "&#6|", "&#x|", "&#x4|"])(
    "preserves native paste after an unfinished entity prefix in %s",
    (template) => {
      const position = template.indexOf("|");
      const doc = template.replace("|", "");
      const state = createState(doc, position);

      expect(
        isLiteralMarkdownInsertionContext(state, position, position),
      ).toBe(true);
      expect(paste(state).state.doc.toString()).toBe(
        template.replace("|", URL_TEXT),
      );
    },
  );

  it.each([
    '[ref]: https://example.org\n  "ti|',
    "[ref]: https://example.org\n  'ti|",
    "[ref]: https://example.org\n  (ti|",
  ])(
    "preserves native paste in an unfinished reference title in %j",
    (template) => {
      const position = template.indexOf("|");
      const doc = template.replace("|", "");
      const state = createState(doc, position);

      expect(
        isLiteralMarkdownInsertionContext(state, position, position),
      ).toBe(true);
      expect(paste(state).state.doc.toString()).toBe(
        template.replace("|", URL_TEXT),
      );
    },
  );

  it("preserves a pasted replacement within a bare URL", () => {
    const oldTarget = "https://old.example";
    const doc = `https://example.com/?next=${oldTarget}`;
    const tr = paste(createState(doc, doc.indexOf(oldTarget), doc.length));

    expect(tr.state.doc.toString()).toBe(`https://example.com/?next=${URL_TEXT}`);
  });

  it.each([
    ["<https://old.example>", 1, 20],
    ['<a href="https://old.example">old</a>', 3, 7],
    ["&copy;", 1, 5],
  ])(
    "preserves native replacement of a partial literal node in %s",
    (doc, anchor, head) => {
      const state = createState(doc, anchor, head);
      const tr = paste(state);

      expect(
        isLiteralMarkdownInsertionContext(state, anchor, head),
      ).toBe(true);
      expect(tr.state.doc.toString()).toBe(
        `${doc.slice(0, anchor)}${URL_TEXT}${doc.slice(head)}`,
      );
    },
  );

  it("allows rich replacement when the whole literal container is selected", () => {
    const doc = "[old](https://old.example)";
    const state = createState(doc, 0, doc.length);

    expect(
      isLiteralMarkdownInsertionContext(state, 0, doc.length),
    ).toBe(false);
  });

  it.each([
    "[ref]:\n|",
    "[ref]:\n  |",
    "> [ref]: |",
    "- [ref]: |",
    "1. [ref]: |",
    "> - [ref]: |",
    "> [ref]:\n> |",
    "- [ref]:\n  |",
    "1. [ref]:\n   |",
    "> [ref]:\n|",
  ])(
    "completes a reference destination in %j",
    (template) => {
      const doc = `${template.replace("|", "")}\n\n[ref]`;
      const position = template.indexOf("|");
      const source = paste(createState(doc, position)).state.doc.toString();

      expect(source).toBe(`${template.replace("|", URL_TEXT)}\n\n[ref]`);
      expect(renderToStaticMarkup(createElement(ReactMarkdown, null, source))).toContain(
        `<p><a href="${URL_TEXT}">ref</a></p>`,
      );
    },
  );

  it.each([
    "[ref]:\n\n",
    "[ref]:\nSee ",
    "[ref]: https://example.org\n",
    "Text [ref]:\n",
    "> [ref]:\n>\n> ",
    "- [ref]:\n\n  ",
    "https://example.org ",
  ])("still converts in prose after %j", (doc) => {
    expect(paste(createState(doc)).state.doc.toString()).toBe(`${doc}${LINK}`);
  });

  it.each([
    "[label](https://example.org)|",
    "`code`|",
    "**old**|",
    "&copy;|",
  ])(
    "converts immediately after completed Markdown: %s",
    (template) => {
      const doc = template.replace("|", "");
      expect(paste(createState(doc)).state.doc.toString()).toBe(`${doc}${LINK}`);
    },
  );

  it("preserves native replacement of a selection spanning lines", () => {
    expect(paste(createState("one\ntwo", 0, 7)).state.doc.toString()).toBe(URL_TEXT);
  });

  it("supports multiple selected labels and maps every cursor", () => {
    const state = createState("one two").update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ]),
    }).state;
    const result = paste(state).state;
    const first = `[one](${URL_TEXT})`;
    const second = `[two](${URL_TEXT})`;

    expect(result.doc.toString()).toBe(`${first} ${second}`);
    expect(result.selection.ranges.map((range) => range.head)).toEqual([
      first.length,
      result.doc.length,
    ]);
  });

  it("falls back atomically when one cursor would change surrounding syntax", () => {
    const doc = "a**\n\nsafe ";
    const state = createState(doc).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(doc.length),
      ]),
    }).state;
    const result = paste(state).state;

    expect(result.doc.toString()).toBe(
      `a*${URL_TEXT}*\n\nsafe ${URL_TEXT}`,
    );
    expect(result.doc.toString()).not.toContain("[");
    expect(result.selection.ranges.map((range) => range.head)).toEqual([
      2 + URL_TEXT.length,
      result.doc.length,
    ]);
  });

  it("keeps contextual conversion for 64 nearby selections", () => {
    const labels = Array.from({ length: 64 }, () => "x");
    const doc = labels.join(" ");
    const state = createState(doc).update({
      selection: EditorSelection.create(
        labels.map((_, index) =>
          EditorSelection.range(index * 2, index * 2 + 1),
        ),
      ),
    }).state;

    expect(paste(state).state.doc.toString()).toBe(
      labels.map(() => `[x](${URL_TEXT})`).join(" "),
    );
  });

  it("falls back before advancing the parser across 64 distant selections", () => {
    const gap = "a".repeat(MAX_CONTEXTUAL_PARSE_SPAN + 1);
    const tail = Array.from({ length: 63 }, () => "x").join("\n\n");
    const tailStart = 3 + gap.length + 2;
    const doc = `x\n\n${gap}\n\n${tail}`;
    const state = createState(doc).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        ...Array.from({ length: 63 }, (_, index) =>
          EditorSelection.cursor(tailStart + index * 3 + 1),
        ),
      ]),
    }).state;
    const native = state.update(state.replaceSelection(URL_TEXT), {
      userEvent: "input.type",
    }).state.doc.toString();
    syntaxTreeMock.calls = 0;

    const result = paste(state).state.doc.toString();

    expect(result).toBe(native);
    expect(result).not.toContain("[");
    expect(result.match(/https:\/\/example\.com\/page/g)).toHaveLength(64);
    expect(syntaxTreeMock.calls).toBe(1);
  });

  it("falls back atomically when multicursor context scanning exceeds its budget", () => {
    const doc = "a".repeat(100_000);
    const state = createState(doc).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(doc.length - 2),
        EditorSelection.cursor(doc.length - 1),
      ]),
    }).state;

    const result = paste(state).state.doc.toString();

    expect(result).not.toContain("[");
    expect(result.match(/https:\/\/example\.com\/page/g)).toHaveLength(2);
  });

  it("falls back atomically when parsing cannot reach every pasted range", () => {
    syntaxTreeMock.calls = 0;
    syntaxTreeMock.failOnCall = 2;
    const doc = "first\n\nsecond";
    const state = createState(doc).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(5),
        EditorSelection.cursor(doc.length),
      ]),
    }).state;
    const native = state.update(state.replaceSelection(URL_TEXT), {
      userEvent: "input.type",
    }).state.doc.toString();

    const result = paste(state).state.doc.toString();

    expect(result).toBe(native);
    expect(result).not.toContain("[");
    expect(result.match(/https:\/\/example\.com\/page/g)).toHaveLength(2);
    expect(syntaxTreeMock.calls).toBe(2);
  });

  it("uses native paste before scanning an excessive number of ranges", () => {
    const paragraphCount = 33_334;
    const doc = "a\n\n".repeat(paragraphCount);
    const ranges = Array.from({ length: 1_000 }, (_, index) => {
      const paragraph = Math.floor(
        (index * (paragraphCount - 1)) / 999,
      );
      return EditorSelection.cursor(paragraph * 3);
    });
    const state = createState(doc).update({
      selection: EditorSelection.create(ranges),
    }).state;
    const native = state.update(state.replaceSelection(URL_TEXT), {
      userEvent: "input.type",
    }).state.doc.toString();

    const result = paste(state).state.doc.toString();

    expect(result).toBe(native);
    expect(result).not.toContain("[");
    expect(result.match(/https:\/\/example\.com\/page/g)).toHaveLength(1_000);
    expect(syntaxTreeMock.calls).toBe(0);
  });

  it("undoes and redoes the whole paste in a single step", () => {
    let state = paste(createState("label", 0, 5)).state;
    const dispatch = (tr: Transaction) => {
      state = tr.state;
    };

    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe("label");
    expect(state.selection.main.from).toBe(0);
    expect(state.selection.main.to).toBe(5);
    expect(redo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe(`[label](${URL_TEXT})`);
  });
});
