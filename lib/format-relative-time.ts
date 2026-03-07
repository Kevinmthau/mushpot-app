const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

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

  if (absDiffMs < hourMs) {
    return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / minuteMs), "minute");
  }

  if (absDiffMs < dayMs) {
    return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / hourMs), "hour");
  }

  if (absDiffMs < weekMs) {
    return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / dayMs), "day");
  }

  if (absDiffMs < monthMs) {
    return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / weekMs), "week");
  }

  if (absDiffMs < yearMs) {
    return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / monthMs), "month");
  }

  return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / yearMs), "year");
}
