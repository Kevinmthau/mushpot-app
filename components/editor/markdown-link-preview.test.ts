import { history, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { markdownLinkPaste } from "@/components/editor/markdown-link-paste";
import { markdownLinkPreviews } from "@/components/editor/markdown-link-preview";

const URL_TEXT = "https://example.com/page";

function createState(doc = "", anchor = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      markdown({ base: markdownLanguage }),
      markdownLinkPaste,
      markdownLinkPreviews,
      history(),
    ],
  });
}

function previews(state: EditorState) {
  const result: { from: number; url: string }[] = [];
  state.field(markdownLinkPreviews).between(0, state.doc.length, (from, _to, value) => {
    result.push({ from, url: value.spec.widget.url });
  });
  return result;
}

describe("automatic editor link previews", () => {
  it.each([
    URL_TEXT,
    `<${URL_TEXT}>`,
    `[${URL_TEXT}](${URL_TEXT})`,
  ])("previews a standalone URL in %s", (source) => {
    expect(previews(createState(source))).toEqual([{ from: source.length, url: URL_TEXT }]);
  });

  it.each([
    [`[${URL_TEXT}][page]`, `[page]: ${URL_TEXT}`, URL_TEXT],
    [`[${URL_TEXT}][]`, `[${URL_TEXT}]: ${URL_TEXT}`, URL_TEXT],
    [`[${URL_TEXT}]`, `[${URL_TEXT}]: ${URL_TEXT}`, URL_TEXT],
    [`[${URL_TEXT}][ Page   URL ]`, `[page url]: <${URL_TEXT}> "Page title"`, URL_TEXT],
    ["[https://example.com/a\\*b\\*][page]", "[page]: https://example.com/a*b*", "https://example.com/a*b*"],
    ["[https://example.com/a\\|b][page]", "[page]: https://example.com/a%7Cb", "https://example.com/a%7Cb"],
    ["[https://example.com/a&amp;b][page]", "[page]: https://example.com/a&amp;b", "https://example.com/a&b"],
    ["[https://example.com/a[b]][page]", "[page]: https://example.com/a[b]", "https://example.com/a%5Bb%5D"],
  ])("previews a resolved reference link: %s", (link, definition, url) => {
    const source = `${link}\n\n${definition}`;
    const result = previews(createState(source));
    expect(result).toEqual([{ from: link.length, url }]);
  });

  it.each([
    `[${URL_TEXT}][missing]`,
    `[${URL_TEXT}][]`,
    `[${URL_TEXT}]`,
    `[${URL_TEXT}][page]\n\n[page]: https://example.com/elsewhere`,
    `[Read this][page]\n\n[page]: ${URL_TEXT}`,
    `[${URL_TEXT}]()\n\n[${URL_TEXT}]: ${URL_TEXT}`,
    `[**${URL_TEXT}**][page]\n\n[page]: ${URL_TEXT}`,
    "[https://example.com/a*b*][page]\n\n[page]: https://example.com/a*b*",
    "[https://example.com/a`b`][page]\n\n[page]: https://example.com/a`b`",
    "[https://example.com/a~b~][page]\n\n[page]: https://example.com/a~b~",
    "[https://example.com/a~~b~~][page]\n\n[page]: https://example.com/a~~b~~",
    "> [https://example.com/page][page]\n\n[page]: https://example.com/page",
  ])("preserves unresolved, custom, formatted, and nested references: %s", (source) => {
    expect(previews(createState(source))).toEqual([]);
  });

  it("updates previews when reference definitions are added, edited, and removed", () => {
    const link = `[${URL_TEXT}][page]`;
    const definition = `\n\n[page]: ${URL_TEXT}`;
    let state = createState(link);
    expect(previews(state)).toEqual([]);

    state = state.update({ changes: { from: state.doc.length, insert: definition } }).state;
    expect(previews(state)).toEqual([{ from: link.length, url: URL_TEXT }]);

    const destinationFrom = state.doc.length - URL_TEXT.length;
    state = state.update({ changes: {
      from: destinationFrom, to: state.doc.length, insert: "https://example.com/elsewhere",
    } }).state;
    expect(previews(state)).toEqual([]);

    state = state.update({ changes: {
      from: destinationFrom, to: state.doc.length, insert: URL_TEXT,
    } }).state;
    expect(previews(state)).toEqual([{ from: link.length, url: URL_TEXT }]);

    state = state.update({ changes: { from: link.length, to: state.doc.length } }).state;
    expect(previews(state)).toEqual([]);
  });

  it.each([
    ["https://example.com/path_name", "https://example.com/path_name"],
    ["https://example.com/a_(b)?tag=[x]&copy;=yes", "https://example.com/a_(b)?tag=%5Bx%5D&copy;=yes"],
    ["https://example.com/a|b", "https://example.com/a%7Cb"],
  ])("previews pasted URLs with Markdown punctuation: %s", (url, expected) => {
    const state = createState();
    const pasted = state.update(state.replaceSelection(url), { userEvent: "input.paste" }).state;
    expect(previews(pasted)).toHaveLength(1);
    expect(previews(pasted)[0].url).toBe(expected);
  });

  it("shows the preview at the paste cursor and undoes/redoes in one step", () => {
    let state = createState();
    state = state.update(state.replaceSelection(URL_TEXT), { userEvent: "input.paste" }).state;
    const content = state.doc.toString();
    expect(previews(state)).toEqual([{ from: content.length, url: URL_TEXT }]);
    expect(state.selection.main.head).toBe(content.length);
    const dispatch = (transaction: Transaction) => { state = transaction.state; };
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.length).toBe(0);
    expect(previews(state)).toEqual([]);
    expect(redo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe(content);
    expect(previews(state)).toHaveLength(1);
  });

  it.each([
    `See ${URL_TEXT}`,
    `${URL_TEXT} and more`,
    `${URL_TEXT}\nMore text`,
    `[Read this](${URL_TEXT})`,
    `![${URL_TEXT}](${URL_TEXT})`,
    `\`${URL_TEXT}\``,
    `\`\`\`\n${URL_TEXT}\n\`\`\``,
    `    ${URL_TEXT}`,
    `# ${URL_TEXT}`,
    `> ${URL_TEXT}`,
    `- ${URL_TEXT}`,
    `| Link |\n| --- |\n| ${URL_TEXT} |`,
    "javascript:alert(1)",
    "https://user:password@example.com/",
    "[https://example.com/a*b*](https://example.com/a*b*)",
    "[https://example.com/a`b`](https://example.com/a`b`)",
    "[https://example.com/a~b~](https://example.com/a~b~)",
  ])("keeps non-standalone links and literal contexts compact: %s", (source) => {
    expect(previews(createState(source))).toEqual([]);
  });

  it("removes previews when text makes a URL inline and leaves source intact", () => {
    const initial = createState(URL_TEXT);
    const edited = initial.update({ changes: { from: 0, insert: "See " } }).state;
    expect(previews(edited)).toEqual([]);
    expect(edited.doc.toString()).toBe(`See ${URL_TEXT}`);
  });

  it("reuses decorations during selection movement", () => {
    const state = createState(URL_TEXT);
    const moved = state.update({ selection: { anchor: 2 } }).state;
    expect(moved.field(markdownLinkPreviews)).toBe(state.field(markdownLinkPreviews));
  });

  it("follows the live-formatting limit in long documents", () => {
    expect(previews(createState(`${URL_TEXT}\n\n${"text ".repeat(4_001)}`))).toEqual([]);
    expect(previews(createState(`${URL_TEXT}\n${"\n".repeat(401)}`))).toEqual([]);
  });
});
