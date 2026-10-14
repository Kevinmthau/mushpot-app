import { ensureSyntaxTree } from "@codemirror/language";
import {
  Annotation,
  EditorState,
  Transaction,
  type ChangeSet,
  type ChangeSpec,
} from "@codemirror/state";

const MAX_LITERAL_CONTEXT_SCAN_LENGTH = 100_000;
const MAX_LINK_BOUNDARY_CONTEXT_LENGTH = 100_000;
export const MAX_CONTEXTUAL_PASTE_RANGES = 64;
export const MAX_CONTEXTUAL_PARSE_SPAN = 100_000;

export const markdownLinkPasteApplication = Annotation.define<{
  nativeChanges: ChangeSet;
  resultChanges: ChangeSet;
}>();

export type MarkdownContextScanBudget = {
  exhausted: boolean;
  parserFrom: number | null;
  parserTo: number | null;
  remaining: number;
};

export function createMarkdownContextScanBudget(): MarkdownContextScanBudget {
  return {
    exhausted: false,
    parserFrom: null,
    parserTo: null,
    remaining: MAX_LITERAL_CONTEXT_SCAN_LENGTH,
  };
}

function reserveMarkdownParserRange(
  scanBudget: MarkdownContextScanBudget | undefined,
  from: number,
  to: number,
) {
  if (!scanBudget) return true;
  if (scanBudget.exhausted) return false;
  // The first ensureSyntaxTree call has its own timeout. Bound subsequent
  // advancement relative to that request so distant cursors cannot multiply
  // the timeout while a normal paste late in a large document still works.
  const parserFrom = Math.min(from, to, scanBudget.parserFrom ?? from);
  const parserTo = Math.max(from, to, scanBudget.parserTo ?? to);
  if (parserTo - parserFrom > MAX_CONTEXTUAL_PARSE_SPAN) {
    scanBudget.exhausted = true;
    return false;
  }
  scanBudget.parserFrom = parserFrom;
  scanBudget.parserTo = parserTo;
  return true;
}

function stripContainerPrefix(text: string) {
  return text.replace(
    /^(?: {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))+/,
    "",
  );
}

export function isLiteralMarkdownNodeName(name: string) {
  return /^(?:InlineCode|FencedCode|CodeBlock|Link|Image|Autolink|URL|LinkReference|HTMLBlock|HTMLTag|CommentBlock|ProcessingInstructionBlock|Entity)$/.test(
    name,
  );
}

function partiallyOverlapsLiteralMarkdownNode(
  state: EditorState,
  from: number,
  to: number,
  scanBudget?: MarkdownContextScanBudget,
) {
  if (!reserveMarkdownParserRange(scanBudget, from, to)) return true;
  const tree = ensureSyntaxTree(state, to, 50);
  if (!tree) {
    if (scanBudget) scanBudget.exhausted = true;
    return true;
  }

  let overlaps = false;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (
        isLiteralMarkdownNodeName(node.name) &&
        node.from < to &&
        node.to > from &&
        (node.from < from || node.to > to)
      ) {
        overlaps = true;
        return false;
      }
    },
  });
  return overlaps;
}

function isMarkdownWhitespace(character: string) {
  return !character || /\s/u.test(character);
}

function isMarkdownPunctuation(character: string) {
  return Boolean(character) && /[\p{P}\p{S}]/u.test(character);
}

type ParsedInlineRange = {
  from: number;
  name: string;
  to: number;
};

type UnfinishedInlineLinkState =
  | { phase: "start"; sawWhitespace: boolean }
  | { phase: "angle-destination" }
  | { nestedParentheses: number; phase: "bare-destination" }
  | { phase: "after-destination" }
  | { delimiter: "\"" | "'"; phase: "quoted-title" }
  | { phase: "parenthesized-title" }
  | { phase: "after-title" }
  | { phase: "invalid" };

function hasPotentialUnfinishedLinkOrImageSyntax(
  prefix: string,
  parsedRanges: ReadonlyArray<ParsedInlineRange>,
) {
  // Lezer can parse a completed label or destination while leaving the
  // following opener/title unfinished. Skip inert parsed nodes, but retain
  // their kind and boundary so the surrounding inline grammar stays visible.
  const ignoredRanges = parsedRanges
    .filter(
      ({ name }) => isLiteralMarkdownNodeName(name) || name === "Escape",
    )
    .toSorted((left, right) => left.from - right.from || left.to - right.to);
  let ignoredRangeIndex = 0;
  let labelDepth = 0;
  let closedLabelEnd = -1;
  let linkState: UnfinishedInlineLinkState | null = null;

  for (let index = 0; index < prefix.length; ) {
    while (
      ignoredRangeIndex < ignoredRanges.length &&
      ignoredRanges[ignoredRangeIndex].to <= index
    ) {
      ignoredRangeIndex += 1;
    }
    const ignoredRange = ignoredRanges[ignoredRangeIndex];
    if (
      ignoredRange &&
      ignoredRange.from <= index &&
      index < ignoredRange.to
    ) {
      if (linkState?.phase === "start") {
        linkState =
          ignoredRange.name === "Autolink" &&
          prefix[ignoredRange.from] === "<" &&
          prefix[ignoredRange.to - 1] === ">"
            ? { phase: "after-destination" }
            : { phase: "bare-destination", nestedParentheses: 0 };
      } else if (!linkState) {
        closedLabelEnd =
          /^(?:Link|Image)$/.test(ignoredRange.name) &&
          prefix[ignoredRange.to - 1] === "]"
            ? ignoredRange.to
            : -1;
      }
      index = ignoredRange.to;
      continue;
    }

    const character = prefix[index];
    if (!linkState) {
      if (character === "\\") {
        closedLabelEnd = -1;
        index = Math.min(prefix.length, index + 2);
        continue;
      }
      if (character === "[") {
        labelDepth += 1;
        closedLabelEnd = -1;
      } else if (character === "]" && labelDepth > 0) {
        labelDepth -= 1;
        closedLabelEnd = labelDepth === 0 ? index + 1 : -1;
      } else if (character === "(" && closedLabelEnd === index) {
        linkState = { phase: "start", sawWhitespace: false };
        closedLabelEnd = -1;
      } else {
        closedLabelEnd = -1;
      }
      index += 1;
      continue;
    }

    if (character === "\\") {
      index = Math.min(prefix.length, index + 2);
      continue;
    }

    switch (linkState.phase) {
      case "start":
        if (isMarkdownWhitespace(character)) {
          linkState.sawWhitespace = true;
        } else if (character === ")") {
          linkState = null;
        } else if (character === "<") {
          linkState = { phase: "angle-destination" };
        } else if (
          linkState.sawWhitespace &&
          (character === "\"" || character === "'")
        ) {
          linkState = { delimiter: character, phase: "quoted-title" };
        } else if (linkState.sawWhitespace && character === "(") {
          linkState = { phase: "parenthesized-title" };
        } else {
          linkState = {
            nestedParentheses: character === "(" ? 1 : 0,
            phase: "bare-destination",
          };
        }
        break;
      case "angle-destination":
        if (character === ">") {
          linkState = { phase: "after-destination" };
        }
        break;
      case "bare-destination":
        if (character === "(") {
          linkState.nestedParentheses += 1;
        } else if (character === ")") {
          if (linkState.nestedParentheses > 0) {
            linkState.nestedParentheses -= 1;
          } else {
            linkState = null;
          }
        } else if (
          isMarkdownWhitespace(character) &&
          linkState.nestedParentheses === 0
        ) {
          linkState = { phase: "after-destination" };
        }
        break;
      case "after-destination":
        if (character === ")") {
          linkState = null;
        } else if (character === "\"" || character === "'") {
          linkState = { delimiter: character, phase: "quoted-title" };
        } else if (character === "(") {
          linkState = { phase: "parenthesized-title" };
        } else if (!isMarkdownWhitespace(character)) {
          linkState = { phase: "invalid" };
        }
        break;
      case "quoted-title":
        if (character === linkState.delimiter) {
          linkState = { phase: "after-title" };
        }
        break;
      case "parenthesized-title":
        if (character === ")") {
          linkState = { phase: "after-title" };
        }
        break;
      case "after-title":
        if (character === ")") {
          linkState = null;
        } else if (!isMarkdownWhitespace(character)) {
          linkState = { phase: "invalid" };
        }
        break;
      case "invalid":
        if (character === ")") linkState = null;
        break;
    }
    index += 1;
  }

  return labelDepth > 0 || linkState !== null;
}

function hasPotentialUnfinishedInlineSyntax(
  prefix: string,
  parsedRanges: ReadonlyArray<ParsedInlineRange>,
) {
  if (prefix.length > MAX_LITERAL_CONTEXT_SCAN_LENGTH) return true;
  if (hasPotentialUnfinishedLinkOrImageSyntax(prefix, parsedRanges)) {
    return true;
  }
  const unparsed = prefix.split("");
  for (const range of parsedRanges) {
    unparsed.fill(" ", Math.max(0, range.from), Math.min(prefix.length, range.to));
  }
  const source = unparsed.join("");

  if (source.includes("`")) return true;
  if (/&(?:#[0-9]*|#[xX][0-9A-Fa-f]*|[A-Za-z][A-Za-z0-9]*)?$/u.test(source)) {
    return true;
  }
  if (/<(?:!--|\?|\/?[A-Za-z])[^>]*$/u.test(source)) return true;
  if (/(?:^|[\s([{])(?:\*{1,3}|_{1,3}|~{2})$/u.test(source)) return true;

  for (const match of source.matchAll(/[*_~]+/g)) {
    const marker = match[0];
    const character = marker[0];
    if (character === "~" && marker.length < 2) continue;
    const index = match.index;
    const before = source[index - 1] ?? "";
    const after = source[index + marker.length] ?? "";
    const leftFlanking =
      !isMarkdownWhitespace(after) &&
      (!isMarkdownPunctuation(after) ||
        isMarkdownWhitespace(before) ||
        isMarkdownPunctuation(before));
    const rightFlanking =
      !isMarkdownWhitespace(before) &&
      (!isMarkdownPunctuation(before) ||
        isMarkdownWhitespace(after) ||
        isMarkdownPunctuation(after));
    if (
      leftFlanking &&
      (character !== "_" || !rightFlanking || isMarkdownPunctuation(before))
    ) {
      return true;
    }
  }
  return false;
}

export function isLiteralMarkdownContext(
  state: EditorState,
  from: number,
  to: number,
  scanBudget?: MarkdownContextScanBudget,
) {
  if (scanBudget?.exhausted) return true;
  const selectionScanLength = Math.max(0, to - from);
  if (scanBudget) {
    if (selectionScanLength > scanBudget.remaining) {
      scanBudget.exhausted = true;
      return true;
    }
    scanBudget.remaining -= selectionScanLength;
  }
  if (!reserveMarkdownParserRange(scanBudget, from, to)) return true;
  const tree = ensureSyntaxTree(state, to, 50);
  // Preserve native paste if parsing has not reached the insertion point yet.
  if (!tree) {
    if (scanBudget) scanBudget.exhausted = true;
    return true;
  }

  let literal = false;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (
        isLiteralMarkdownNodeName(node.name) &&
        node.from < to &&
        node.to > from
      ) {
        literal = true;
        return false;
      }

      // Appending a query value still edits the existing bare URL.
      if (node.name === "URL" && from === to && from === node.to) {
        literal = true;
      }

      // An unfinished code block also includes the cursor at its end.
      if (
        from === node.to &&
        (node.name === "CodeBlock" ||
          (node.name === "FencedCode" &&
            (node.node.lastChild?.name !== "CodeMark" ||
              node.node.lastChild?.from === node.node.firstChild?.from)))
      ) {
        literal = true;
      }
    },
  });

  const line = state.doc.lineAt(from);
  const contextTo = Math.max(from, to);
  let inlinePrefixFrom = line.from;
  let prefixNode = tree.resolveInner(from, -1);
  while (prefixNode) {
    if (prefixNode.name === "Paragraph") {
      inlinePrefixFrom = prefixNode.from;
      break;
    }
    const parent = prefixNode.parent;
    if (!parent) break;
    prefixNode = parent;
  }
  const inlinePrefixLength = contextTo - inlinePrefixFrom;
  const availableScanLength = Math.min(
    MAX_LITERAL_CONTEXT_SCAN_LENGTH,
    scanBudget?.remaining ?? MAX_LITERAL_CONTEXT_SCAN_LENGTH,
  );
  if (inlinePrefixLength > availableScanLength) {
    if (scanBudget) scanBudget.exhausted = true;
    return true;
  }
  if (scanBudget) scanBudget.remaining -= inlinePrefixLength;

  const prefix = state.doc.sliceString(line.from, contextTo);
  const inlinePrefix = state.doc.sliceString(inlinePrefixFrom, contextTo);
  const parsedPrefixRanges: ParsedInlineRange[] = [];
  tree.iterate({
    from: inlinePrefixFrom,
    to: contextTo,
    enter(node) {
      if (isLiteralMarkdownNodeName(node.name) || node.name === "Escape") {
        parsedPrefixRanges.push({
          from: node.from - inlinePrefixFrom,
          name: node.name,
          to: node.to - inlinePrefixFrom,
        });
        return false;
      }
      if (/^(?:Emphasis|StrongEmphasis|Strikethrough)$/.test(node.name)) {
        parsedPrefixRanges.push({
          from: node.from - inlinePrefixFrom,
          name: node.name,
          to: node.to - inlinePrefixFrom,
        });
      }
    },
  });
  const blankIndentedLine =
    /^(?: {4}|\t)\s*$/.test(prefix) &&
    tree.resolveInner(from, -1).name === "Document";
  const referencePrefix = stripContainerPrefix(prefix);
  // A reference destination may start on the very next line, before the
  // incomplete definition has a LinkReference node in the syntax tree.
  const continuesReferenceDestination =
    line.number > 1 &&
    /^[ \t]*$/.test(referencePrefix) &&
    /^ {0,3}\[[^\]]+\]:[ \t]*$/.test(
      stripContainerPrefix(state.doc.line(line.number - 1).text),
    );
  let continuesReferenceTitle = false;
  if (
    line.number > 1 &&
    /^[ \t]*(?:"(?:\\.|[^"\\])*|'(?:\\.|[^'\\])*|\((?:\\.|[^)\\])*)$/u.test(
      referencePrefix,
    )
  ) {
    const previousLine = state.doc.line(line.number - 1);
    tree.iterate({
      from: previousLine.from,
      to: previousLine.to,
      enter(node) {
        if (
          node.name === "LinkReference" &&
          node.from >= previousLine.from &&
          node.to <= previousLine.to &&
          node.node.getChild("URL") &&
          !node.node.getChild("LinkTitle")
        ) {
          continuesReferenceTitle = true;
          return false;
        }
      },
    });
  }
  // Incomplete destinations may not yet have a Link/LinkReference syntax node.
  return (
    literal ||
    blankIndentedLine ||
    continuesReferenceDestination ||
    continuesReferenceTitle ||
    /^ {0,3}\[[^\]]+\]:/.test(referencePrefix) ||
    hasPotentialUnfinishedInlineSyntax(inlinePrefix, parsedPrefixRanges)
  );
}

export function isLiteralMarkdownInsertionContext(
  state: EditorState,
  from: number,
  to: number,
  scanBudget?: MarkdownContextScanBudget,
  preparedInsertionState?: EditorState,
) {
  if (from === to) {
    return isLiteralMarkdownContext(state, from, to, scanBudget);
  }
  if (scanBudget) {
    const selectionLength = to - from;
    if (scanBudget.exhausted || selectionLength > scanBudget.remaining) {
      scanBudget.exhausted = true;
      return true;
    }
    scanBudget.remaining -= selectionLength;
  }
  // Inspect the original tree before deleting the selection. Otherwise a
  // partial selection inside an autolink, HTML tag, or entity can look like
  // ordinary prose after deletion and be replaced with generated Markdown.
  // A selection that encloses the complete literal node remains replaceable.
  if (partiallyOverlapsLiteralMarkdownNode(state, from, to, scanBudget)) {
    return true;
  }
  return isLiteralMarkdownContext(
    preparedInsertionState ??
      state.update({ changes: { from, to }, filter: false }).state,
    from,
    from,
    scanBudget,
  );
}

function escapeLabel(label: string) {
  return label.replace(/[\\[\]`*_<>~|&]/g, "\\$&");
}

export function getStandaloneHttpUrlPaste(text: string) {
  const match = /^(\s*)((?:https?:\/\/|mailto:|xmpp:|www\.)[^\s<>\\]+)(\s*)$/i.exec(
    text,
  );
  if (!match) return null;

  const [, before, pastedUrl, after] = match;
  const supportsEmptySelection = /^https?:\/\//i.test(pastedUrl);
  const url = /^www\./i.test(pastedUrl)
    ? `https://${pastedUrl}`
    : pastedUrl;
  try {
    const parsed = new URL(url);
    if (!/^(?:https?|mailto|xmpp):$/.test(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return { after, before, supportsEmptySelection, url };
}

function markdownParagraphEnd(
  state: EditorState,
  from: number,
  scanBudget: MarkdownContextScanBudget,
) {
  if (scanBudget.exhausted || scanBudget.remaining <= 0) {
    scanBudget.exhausted = true;
    return null;
  }
  const searchEnd = Math.min(
    state.doc.length,
    from + Math.min(MAX_LINK_BOUNDARY_CONTEXT_LENGTH, scanBudget.remaining),
  );
  const suffix = state.doc.sliceString(from, searchEnd);
  const paragraphBreak = /\n[ \t]*\n/.exec(suffix);
  const consumed = paragraphBreak
    ? paragraphBreak.index + paragraphBreak[0].length
    : suffix.length;
  scanBudget.remaining -= consumed;
  if (!paragraphBreak && searchEnd < state.doc.length) {
    scanBudget.exhausted = true;
    return null;
  }
  return paragraphBreak
    ? from + paragraphBreak.index + paragraphBreak[0].length
    : state.doc.length;
}

function surroundingInlineSyntaxSnapshot(
  tree: NonNullable<ReturnType<typeof ensureSyntaxTree>>,
  from: number,
  to: number,
) {
  const nodes: string[] = [];
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.to <= from || node.from >= to) return false;
      if (node.from >= from && node.to <= to) return false;
      if (
        /^(?:Autolink|Emphasis|StrongEmphasis|Strikethrough|Link|Image|LinkReference|InlineCode|HTMLTag|Entity|Escape)$/.test(
          node.name,
        )
      ) {
        nodes.push(`${node.name}:${node.from - from}:${node.to - to}`);
      }
    },
  });
  return nodes;
}

export const markdownLinkPaste = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Transaction.userEvent) !== "input.paste") {
    return tr;
  }

  const candidates: Array<{
    fromA: number;
    fromB: number;
    parsed: NonNullable<ReturnType<typeof getStandaloneHttpUrlPaste>>;
    toA: number;
    toB: number;
  }> = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const parsed = getStandaloneHttpUrlPaste(inserted.toString());
    if (parsed && (fromA !== toA || parsed.supportsEmptySelection)) {
      candidates.push({ fromA, fromB, parsed, toA, toB });
    }
  });

  // Each context check may have to advance the Markdown parser. Large shared
  // pastes should stay as cheap as CodeMirror's native multi-range insertion.
  if (
    candidates.length === 0 ||
    candidates.length > MAX_CONTEXTUAL_PASTE_RANGES
  ) {
    return tr;
  }

  const changes: ChangeSpec[] = [];
  const generatedLinks: Array<{
    beforeLength: number;
    from: number;
    linkLength: number;
    nativeFrom: number;
    nativeTo: number;
  }> = [];
  const scanBudget = createMarkdownContextScanBudget();
  for (const { fromA, fromB, parsed, toA, toB } of candidates) {
    const { after, before, url } = parsed;

    const selected = tr.startState.doc.sliceString(fromA, toA);
    if (
      selected.includes("\n") ||
      isLiteralMarkdownContext(tr.startState, fromA, toA, scanBudget)
    ) {
      continue;
    }

    // Ampersands must stay literal even when they look like HTML entities.
    const destination = url.replace(/&/g, "&amp;").replace(/\|/g, "%7C");
    const target = /[()]/.test(destination) ? `<${destination}>` : destination;
    const link = `[${escapeLabel(selected || url)}](${target})`;
    changes.push({
      from: fromB,
      to: toB,
      insert: `${before}${link}${after}`,
    });
    generatedLinks.push({
      beforeLength: before.length,
      from: fromB,
      linkLength: link.length,
      nativeFrom: fromB + before.length,
      nativeTo: toB - after.length,
    });
  }

  if (scanBudget.exhausted || changes.length === 0) return tr;

  const trial = tr.state.update({ changes, filter: false });
  const expectedLinks = generatedLinks.map(
    ({ beforeLength, from, linkLength, nativeFrom, nativeTo }) => {
      const mappedFrom = trial.changes.mapPos(from, -1) + beforeLength;
      return {
        from: mappedFrom,
        nativeFrom,
        nativeTo,
        to: mappedFrom + linkLength,
      };
    },
  );
  const nativeParseEnds = expectedLinks.map(({ nativeTo }) =>
    markdownParagraphEnd(tr.state, nativeTo, scanBudget),
  );
  if (nativeParseEnds.some((value) => value === null)) return tr;
  const trialParseEnds = (nativeParseEnds as number[]).map((position) =>
    trial.changes.mapPos(position, 1),
  );
  if (
    !reserveMarkdownParserRange(
      scanBudget,
      Math.min(...expectedLinks.map(({ from, nativeFrom }) => Math.min(from, nativeFrom))),
      Math.max(...trialParseEnds, ...(nativeParseEnds as number[])),
    )
  ) {
    return tr;
  }
  const nativeTree = ensureSyntaxTree(
    tr.state,
    Math.max(...(nativeParseEnds as number[])),
    100,
  );
  const tree = ensureSyntaxTree(
    trial.state,
    Math.max(...trialParseEnds),
    100,
  );
  if (!nativeTree || !tree) return tr;

  const remainingLinks = new Set(
    expectedLinks.map(({ from, to }) => `${from}:${to}`),
  );
  tree.iterate({
    from: Math.min(...expectedLinks.map(({ from }) => from)),
    to: Math.max(...expectedLinks.map(({ to }) => to)),
    enter(node) {
      if (node.name === "Link") {
        remainingLinks.delete(`${node.from}:${node.to}`);
      }
    },
  });
  const preservesSurroundingSyntax = expectedLinks.every(
    ({ from, nativeFrom, nativeTo, to }) => {
      const nativeSyntax = surroundingInlineSyntaxSnapshot(
        nativeTree,
        nativeFrom,
        nativeTo,
      );
      const generatedSyntax = surroundingInlineSyntaxSnapshot(tree, from, to);
      return (
        nativeSyntax.length === generatedSyntax.length &&
        nativeSyntax.every((node, index) => node === generatedSyntax[index])
      );
    },
  );
  if (remainingLinks.size !== 0 || !preservesSurroundingSyntax) return tr;
  const applied = tr.state.update({ changes, filter: false });
  return [
    tr,
    {
      annotations: markdownLinkPasteApplication.of({
        nativeChanges: tr.changes,
        resultChanges: tr.changes.compose(applied.changes),
      }),
      changes,
      sequential: true,
    },
  ];
});
