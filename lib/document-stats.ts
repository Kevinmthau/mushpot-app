export function countWords(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  return trimmed.split(/\s+/).length;
}

export function estimateReadingTime(wordCount: number) {
  if (wordCount === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(wordCount / 225));
}

export function getReadingTimeFromText(text: string) {
  return estimateReadingTime(countWords(text));
}
