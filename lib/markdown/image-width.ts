const IMAGE_WIDTH_TOKEN_PATTERN =
  /^[ \t]*\{[ \t]*width[ \t]*=[ \t]*([0-9]+(?:\.[0-9]+)?(?:px|%)?)[ \t]*\}/i;

function stripTrailingZeros(value: number) {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(3).replace(/\.?0+$/, "");
}

export function normalizeMarkdownImageWidth(rawValue: string) {
  const normalized = rawValue.trim().toLowerCase();
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(px|%)?$/);
  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const value = stripTrailingZeros(numeric);
  const unit = match[2];

  if (unit === "%") {
    if (numeric > 100) {
      return null;
    }

    return `${value}%`;
  }

  return `${value}px`;
}

export function parseImageWidthTokenFromText(text: string) {
  const match = text.match(IMAGE_WIDTH_TOKEN_PATTERN);
  if (!match) {
    return null;
  }

  const width = normalizeMarkdownImageWidth(match[1]);
  if (!width) {
    return null;
  }

  return {
    consumedChars: match[0].length,
    width,
  };
}
