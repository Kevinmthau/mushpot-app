import { type EditorState } from "@codemirror/state";

const MAX_LIVE_FORMATTING_DOC_LENGTH = 20_000;
const MAX_LIVE_FORMATTING_LINE_COUNT = 400;

export function shouldDisableLiveFormattingState(state: EditorState) {
  return (
    state.doc.length > MAX_LIVE_FORMATTING_DOC_LENGTH ||
    state.doc.lines > MAX_LIVE_FORMATTING_LINE_COUNT
  );
}

export function selectionIntersectsStateRange(
  state: EditorState,
  from: number,
  to: number,
) {
  return state.selection.ranges.some((range) => {
    if (range.from === range.to) {
      return range.from >= from && range.from <= to;
    }

    return range.from < to && range.to > from;
  });
}

export function selectionIntersectsTableRange(
  state: EditorState,
  from: number,
  to: number,
) {
  return state.selection.ranges.some((range) => {
    if (range.from === range.to) {
      return range.from > from && range.from < to;
    }

    return range.from < to && range.to > from;
  });
}
