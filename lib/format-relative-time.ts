export function formatRelativeTimestamp(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "just now";
  }

  const diffMs = timestamp - Date.now();
  const absDiffMs = Math.abs(diffMs);

  if (absDiffMs < 45_000) {
    return "just now";
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;

  const suffix = diffMs < 0 ? " ago" : " from now";

  if (absDiffMs < hourMs) {
    const n = Math.round(absDiffMs / minuteMs);
    return `${n}min${suffix}`;
  }

  if (absDiffMs < dayMs) {
    const n = Math.round(absDiffMs / hourMs);
    return `${n}hrs${suffix}`;
  }

  if (absDiffMs < weekMs) {
    const n = Math.round(absDiffMs / dayMs);
    return `${n}d${suffix}`;
  }

  if (absDiffMs < monthMs) {
    const n = Math.round(absDiffMs / weekMs);
    return `${n}w${suffix}`;
  }

  if (absDiffMs < yearMs) {
    const n = Math.round(absDiffMs / monthMs);
    return `${n}mo${suffix}`;
  }

  const n = Math.round(absDiffMs / yearMs);
  return `${n}y${suffix}`;
}
