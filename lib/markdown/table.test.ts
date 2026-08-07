import { describe, expect, it } from "vitest";

import {
  parseMarkdownReferenceDefinitions,
  parseMarkdownTable,
} from "@/lib/markdown/table";

function inlineText(
  content: NonNullable<ReturnType<typeof parseMarkdownTable>>["header"][number]["content"],
): string {
  return content
    .map((part) => {
      if (part.type === "break") {
        return "\n";
      }
      if (part.type === "code" || part.type === "text") {
        return part.text;
      }
      if (part.type === "media") {
        return part.altText;
      }
      return inlineText(part.children);
    })
    .join("");
}

describe("parseMarkdownTable", () => {
  it("parses a GFM table with formatting, escaped pipes, and alignment", () => {
    const table = parseMarkdownTable(
      [
        "| **Date / Funding** | Milestone | Why investors care |",
        "| :--- | :---: | ---: |",
        "| **Aug 2026** | Architecture \\| product freeze | `Proof` milestone |",
      ].join("\n"),
    );

    expect(table).not.toBeNull();
    expect(table?.alignments).toEqual(["left", "center", "right"]);
    expect(table?.header.map((cell) => inlineText(cell.content))).toEqual([
      "Date / Funding",
      "Milestone",
      "Why investors care",
    ]);
    expect(table?.rows[0].map((cell) => inlineText(cell.content))).toEqual([
      "Aug 2026",
      "Architecture | product freeze",
      "Proof milestone",
    ]);
    expect(table?.header[0].content[0]?.type).toBe("strong");
    expect(table?.rows[0][2].content[0]?.type).toBe("code");
  });

  it("supports tables without outer pipes and pads short rows", () => {
    const table = parseMarkdownTable(
      ["Name | Value", "--- | ---", "One"].join("\n"),
    );

    expect(table?.header).toHaveLength(2);
    expect(table?.rows[0]).toHaveLength(2);
    expect(table?.rows[0][1].content).toEqual([]);
  });

  it("preserves leading, interior, trailing, and all-empty cells", () => {
    const table = parseMarkdownTable(
      [
        "|| Heading || Tail |",
        "| --- | --- | --- | --- |",
        "|| Value || End |",
      ].join("\n"),
    );
    const allEmptyHeader = parseMarkdownTable(
      ["|||", "| --- | --- |", "| Left | Right |"].join("\n"),
    );

    expect(table?.header.map((cell) => inlineText(cell.content))).toEqual([
      "",
      "Heading",
      "",
      "Tail",
    ]);
    expect(table?.rows[0].map((cell) => inlineText(cell.content))).toEqual([
      "",
      "Value",
      "",
      "End",
    ]);
    expect(allEmptyHeader?.header).toHaveLength(2);
    expect(
      allEmptyHeader?.header.map((cell) => inlineText(cell.content)),
    ).toEqual(["", ""]);
  });

  it("matches GFM handling for extra cells, entities, code, links, and images", () => {
    const table = parseMarkdownTable(
      [
        "| Entity | Code | Link | Image |",
        "| --- | --- | --- | --- |",
        "| &copy; | ` padded ` | [Label]() | ![Alt](https://example.com/a.png) | extra |",
        "| &#x26; | `a\\|b` | Plain | Plain |",
      ].join("\n"),
    );

    expect(table?.rows[0]).toHaveLength(4);
    expect(table?.rows[0].map((cell) => inlineText(cell.content))).toEqual([
      "©",
      "padded",
      "Label",
      "Alt",
    ]);
    expect(table?.rows[1].map((cell) => inlineText(cell.content))).toEqual([
      "&",
      "a|b",
      "Plain",
      "Plain",
    ]);
  });

  it("retains image and video metadata for table media previews", () => {
    const table = parseMarkdownTable(
      [
        "| Image | Video |",
        "| --- | --- |",
        '| ![**Diagram**](https://example.com/diagram.png "Diagram title") | ![Demo](https://example.com/demo.mp4 "poster=https://example.com/poster.jpg") |',
      ].join("\n"),
    );

    expect(table?.rows[0][0].content).toEqual([
      {
        altText: "Diagram",
        src: "https://example.com/diagram.png",
        title: "Diagram title",
        type: "media",
      },
    ]);
    expect(table?.rows[0][1].content).toEqual([
      {
        altText: "Demo",
        src: "https://example.com/demo.mp4",
        title: "poster=https://example.com/poster.jpg",
        type: "media",
      },
    ]);
  });

  it("resolves links and media from definitions outside the table", () => {
    const tableSource = [
      "| Link | Media |",
      "| --- | --- |",
      "| [OpenAI][OA] | ![Demo][clip] |",
    ].join("\n");
    const documentSource = [
      tableSource,
      "",
      '[oa]: https://openai.com "OpenAI home"',
      '[clip]: https://example.com/demo.mp4 "poster=https://example.com/poster.jpg"',
    ].join("\n");
    const references = parseMarkdownReferenceDefinitions(documentSource);
    const table = parseMarkdownTable(tableSource, { references });

    expect(table?.rows[0][0].content).toEqual([
      {
        children: [{ text: "OpenAI", type: "text" }],
        href: "https://openai.com",
        title: "OpenAI home",
        type: "link",
      },
    ]);
    expect(table?.rows[0][1].content).toEqual([
      {
        altText: "Demo",
        src: "https://example.com/demo.mp4",
        title: "poster=https://example.com/poster.jpg",
        type: "media",
      },
    ]);
  });

  it("renders both single- and double-tilde GFM strikethrough", () => {
    const table = parseMarkdownTable(
      ["| Single | Double |", "| --- | --- |", "| a~b~ | ~~c~~ |"].join(
        "\n",
      ),
    );

    expect(table?.rows[0][0].content).toEqual([
      { text: "a", type: "text" },
      {
        children: [{ text: "b", type: "text" }],
        type: "strikethrough",
      },
    ]);
    expect(table?.rows[0][1].content[0]?.type).toBe("strikethrough");
  });

  it("uses CommonMark replacement rules for invalid numeric entities", () => {
    const table = parseMarkdownTable(
      [
        "| C0 | C1 | Noncharacter | Plane tail | Valid tab | Valid emoji |",
        "| --- | --- | --- | --- | --- | --- |",
        "| &#1; | &#x80; | &#xFDD0; | &#x1FFFE; | &#9; | &#x1F642; |",
      ].join("\n"),
    );

    expect(table?.rows[0].map((cell) => inlineText(cell.content))).toEqual([
      "�",
      "�",
      "�",
      "�",
      "\t",
      "🙂",
    ]);
  });

  it("preserves reference syntax, styles autolinks, and replaces invalid entities", () => {
    const table = parseMarkdownTable(
      [
        "| Reference | URL | Email | Invalid entity |",
        "| --- | --- | --- | --- |",
        "| [Label][id] | https://example.com | <user@example.com> | &#0; |",
      ].join("\n"),
    );

    expect(table?.rows[0].map((cell) => inlineText(cell.content))).toEqual([
      "[Label][id]",
      "https://example.com",
      "user@example.com",
      "�",
    ]);
    expect(table?.rows[0][1].content[0]?.type).toBe("link");
    expect(table?.rows[0][2].content[0]?.type).toBe("link");
  });

  it("rejects plain text and malformed tables", () => {
    expect(parseMarkdownTable("A | B\nOne | Two")).toBeNull();
    expect(parseMarkdownTable("Just a paragraph")).toBeNull();
  });
});
