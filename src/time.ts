// Timezone helpers. Workers run in UTC, and so do cron schedules; users
// think in their own local time. Everything here converts between the two.

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at `date` (+330 for Asia/Kolkata). */
export function tzOffsetMinutes(timezone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  const seconds = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((wallClockAsUtc - seconds) / 60_000);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/** "2026-10-13T15:00" as wall-clock time in `timezone` → UTC epoch ms. */
export function localToUtc(localIso: string, timezone: string): number | null {
  const match = LOCAL_DATE_TIME.exec(localIso.trim());
  if (!match) return null;
  const [, y, mo, d, h = "00", mi = "00"] = match;
  const [year, month, day, hour, minute] = [y, mo, d, h, mi].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the offset can differ on either side of a DST change
  let utc =
    wallClockAsUtc -
    tzOffsetMinutes(timezone, new Date(wallClockAsUtc)) * 60_000;
  utc = wallClockAsUtc - tzOffsetMinutes(timezone, new Date(utc)) * 60_000;
  return utc;
}

/**
 * A daily local "HH:MM" as a UTC cron expression, using today's offset:
 * 08:00 in Asia/Kolkata → "30 2 * * *". Zones with daylight saving drift
 * by an hour after a change until the briefing is set again.
 */
export function dailyCronUtc(time: string, timezone: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const offset = tzOffsetMinutes(timezone, new Date());
  const utcMinutes = (((hour * 60 + minute - offset) % 1440) + 1440) % 1440;
  return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * *`;
}

/** Today's date in `timezone` as "YYYY-MM-DD". */
export function localDate(timezone: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/** "Monday 12 October 2026 at 16:05" in `timezone`. */
export function localNow(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
}

/** "Tue 13 Oct, 09:00" in `timezone`. */
export function formatLocal(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(epochMs));
}
