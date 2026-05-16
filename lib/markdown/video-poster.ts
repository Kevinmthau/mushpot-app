const VIDEO_POSTER_TITLE_PREFIX = "poster=";
const VIDEO_POSTER_TITLE_PATTERN = /^poster=(\S+)$/;

export function buildVideoPosterTitle(posterUrl: string) {
  return `${VIDEO_POSTER_TITLE_PREFIX}${posterUrl}`;
}

export function parseVideoPosterFromTitle(title: string | null | undefined) {
  if (!title) {
    return null;
  }

  const match = title.trim().match(VIDEO_POSTER_TITLE_PATTERN);
  return match?.[1] ?? null;
}

export function appendFirstFrameFragment(src: string) {
  if (src.includes("#")) {
    return src;
  }

  return `${src}#t=0.1`;
}
