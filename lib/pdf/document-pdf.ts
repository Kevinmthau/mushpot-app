type BuildDocumentPdfInput = {
  title: string;
  content: string;
  updatedAt?: string;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 72;
const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const MAX_CHARS_PER_LINE = Math.floor(
  (PAGE_WIDTH - PAGE_MARGIN * 2) / (FONT_SIZE * 0.52),
);
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - PAGE_MARGIN * 2) / LINE_HEIGHT);

function normalizeLineBreaks(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function wrapLine(line: string, maxChars: number): string[] {
  if (!line) {
    return [""];
  }

  if (line.length <= maxChars) {
    return [line];
  }

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [line.slice(0, maxChars), ...wrapLine(line.slice(maxChars), maxChars)];
  }

  const wrapped: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (word.length > maxChars) {
      if (currentLine) {
        wrapped.push(currentLine);
        currentLine = "";
      }

      for (let index = 0; index < word.length; index += maxChars) {
        wrapped.push(word.slice(index, index + maxChars));
      }

      continue;
    }

    const nextLine = currentLine ? `${currentLine} ${word}` : word;

    if (nextLine.length <= maxChars) {
      currentLine = nextLine;
      continue;
    }

    wrapped.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    wrapped.push(currentLine);
  }

  return wrapped.length > 0 ? wrapped : [""];
}

function sanitizePdfText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function formatUpdatedAt(updatedAt?: string) {
  if (!updatedAt) {
    return null;
  }

  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return `Updated ${parsed.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function buildTextLines({ title, content, updatedAt }: BuildDocumentPdfInput) {
  const normalizedTitle = title.trim() || "Untitled";
  const updatedLine = formatUpdatedAt(updatedAt);

  const rawLines = [
    normalizedTitle,
    ...(updatedLine ? [updatedLine] : []),
    "",
    ...normalizeLineBreaks(content).split("\n"),
  ];

  const output: string[] = [];

  for (const line of rawLines) {
    if (!line.trim()) {
      output.push("");
      continue;
    }

    output.push(...wrapLine(line, MAX_CHARS_PER_LINE));
  }

  return output.length > 0 ? output : ["Untitled"];
}

function paginateLines(lines: string[]) {
  const pages: string[][] = [];

  for (let index = 0; index < lines.length; index += LINES_PER_PAGE) {
    pages.push(lines.slice(index, index + LINES_PER_PAGE));
  }

  return pages.length > 0 ? pages : [[""]];
}

function buildPageContentStream(lines: string[]) {
  const commands: string[] = ["BT", "/F1 12 Tf"];
  let y = PAGE_HEIGHT - PAGE_MARGIN;

  for (const line of lines) {
    commands.push(`1 0 0 1 ${PAGE_MARGIN} ${y} Tm`);
    commands.push(`(${sanitizePdfText(line)}) Tj`);
    y -= LINE_HEIGHT;
  }

  commands.push("ET");
  return `${commands.join("\n")}\n`;
}

export function buildDocumentPdf(input: BuildDocumentPdfInput) {
  const pages = paginateLines(buildTextLines(input));
  const objectCount = 3 + pages.length * 2;

  let pdf = "%PDF-1.4\n%Mushpot\n";
  const objectOffsets = new Array<number>(objectCount + 1).fill(0);

  const pageIds: number[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    pageIds.push(4 + pageIndex * 2);
  }

  const objects: Array<{ id: number; body: string }> = [
    {
      id: 1,
      body: "<< /Type /Catalog /Pages 2 0 R >>",
    },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pageIds
        .map((pageId) => `${pageId} 0 R`)
        .join(" ")}] /Count ${pages.length} >>`,
    },
    {
      id: 3,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    },
  ];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageId = 4 + pageIndex * 2;
    const contentId = pageId + 1;
    const contentStream = buildPageContentStream(pages[pageIndex]);

    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    objects.push({
      id: contentId,
      body: `<< /Length ${Buffer.byteLength(
        contentStream,
        "latin1",
      )} >>\nstream\n${contentStream}endstream`,
    });
  }

  for (const object of objects) {
    objectOffsets[object.id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${object.id} 0 obj\n${object.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objectCount + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (let objectId = 1; objectId <= objectCount; objectId += 1) {
    pdf += `${String(objectOffsets[objectId]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

export function buildPdfFilename(title: string) {
  const baseName = (title.trim() || "untitled")
    .replace(/[^a-zA-Z0-9-_ ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80);

  return `${baseName || "document"}.pdf`;
}
