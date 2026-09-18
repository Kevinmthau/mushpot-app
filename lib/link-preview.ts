export type LinkPreviewMetadata = {
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  image?: string;
};

export function normalizeLinkPreviewUrl(value: string): string | null {
  if (
    value.length > 8192 ||
    !/^https?:\/\//i.test(value) ||
    /[\s\u0000-\u001f\u007f\\]/.test(value)
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return null;
    // Markdown rendering escapes brackets, and paste escapes pipes for tables.
    // Canonicalize only these characters so label/destination comparison does
    // not change meaningful URL separators such as encoded query ampersands.
    const escapeMarkdownCharacters = (part: string) =>
      part.replace(/[|[\]]/g, (character) => encodeURIComponent(character));
    url.pathname = escapeMarkdownCharacters(url.pathname);
    url.search = escapeMarkdownCharacters(url.search);
    url.hash = escapeMarkdownCharacters(url.hash);
    return url.href;
  } catch {
    return null;
  }
}

export function getStandaloneLinkPreviewUrl(
  href: string | undefined,
  label: string,
): string | null {
  if (!href) return null;
  const url = normalizeLinkPreviewUrl(href);
  return url && normalizeLinkPreviewUrl(label) === url ? url : null;
}
