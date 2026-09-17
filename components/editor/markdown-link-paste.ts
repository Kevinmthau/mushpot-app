import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Transaction, type ChangeSpec } from "@codemirror/state";

function stripContainerPrefix(text: string) {
  return text.replace(
    /^(?: {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))+/,
    "",
  );
}

function isLiteralContext(state: EditorState, from: number, to: number) {
  const tree = ensureSyntaxTree(state, to, 50);
  // Preserve native paste if parsing has not reached the insertion point yet.
  if (!tree) {
    return true;
  }

  let literal = false;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (
        /^(InlineCode|FencedCode|CodeBlock|Link|Image|Autolink|URL|LinkReference|HTMLBlock|HTMLTag)$/.test(
          node.name,
        ) &&
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
  const prefix = state.doc.sliceString(line.from, from);
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
  // Incomplete destinations may not yet have a Link/LinkReference syntax node.
  return (
    literal ||
    blankIndentedLine ||
    continuesReferenceDestination ||
    /\]\([^)]*$/.test(prefix) ||
    /^ {0,3}\[[^\]]+\]:/.test(referencePrefix)
  );
}

function escapeLabel(label: string) {
  return label.replace(/[\\[\]`*_<>~|&]/g, "\\$&");
}

export const markdownLinkPaste = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Transaction.userEvent) !== "input.paste") {
    return tr;
  }

  const changes: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const pasted = inserted.toString();
    const match = /^(\s*)(https?:\/\/[^\s<>\\]+)(\s*)$/i.exec(pasted);
    if (!match) {
      return;
    }

    const [, before, url, after] = match;
    try {
      new URL(url);
    } catch {
      return;
    }

    const selected = tr.startState.doc.sliceString(fromA, toA);
    if (selected.includes("\n") || isLiteralContext(tr.startState, fromA, toA)) {
      return;
    }

    // Ampersands must stay literal even when they look like HTML entities.
    const destination = url.replace(/&/g, "&amp;").replace(/\|/g, "%7C");
    const target = /[()]/.test(destination) ? `<${destination}>` : destination;
    changes.push({
      from: fromB,
      to: toB,
      insert: `${before}[${escapeLabel(selected || url)}](${target})${after}`,
    });
  });

  return changes.length ? [tr, { changes, sequential: true }] : tr;
});
