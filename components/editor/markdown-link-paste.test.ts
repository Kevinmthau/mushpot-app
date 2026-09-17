import { history, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { markdownLinkPaste } from "@/components/editor/markdown-link-paste";

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
  ])("preserves literal paste in %s", (template) => {
    const position = template.indexOf("|");
    const doc = template.replace("|", "");
    const tr = paste(createState(doc, position));

    expect(tr.state.doc.toString()).toBe(template.replace("|", URL_TEXT));
  });

  it("preserves a pasted replacement within a bare URL", () => {
    const oldTarget = "https://old.example";
    const doc = `https://example.com/?next=${oldTarget}`;
    const tr = paste(createState(doc, doc.indexOf(oldTarget), doc.length));

    expect(tr.state.doc.toString()).toBe(`https://example.com/?next=${URL_TEXT}`);
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

  it.each(["[label](https://example.org)|", "`code`|"])(
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
