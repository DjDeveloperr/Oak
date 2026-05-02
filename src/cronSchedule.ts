const CRON_FIELD_RANGES = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 7, name: "day of week" },
] as const;

interface ParsedCronExpression {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

function parseCronNumber(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid cron value: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron value: ${value}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Cron value ${parsed} is outside ${min}-${max}.`);
  }
  return parsed;
}

function expandCronField(
  field: string,
  range: (typeof CRON_FIELD_RANGES)[number],
): Set<number> {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(`Empty cron ${range.name} entry.`);
    }

    const [base, rawStep] = part.split("/");
    if (part.split("/").length > 2 || !base) {
      throw new Error(`Invalid cron ${range.name} entry: ${part}`);
    }
    const step = rawStep
      ? parseCronNumber(rawStep, 1, range.max - range.min + 1)
      : 1;

    let start: number;
    let end: number;
    if (base === "*") {
      start = range.min;
      end = range.max;
    } else if (base.includes("-")) {
      const [rawStart, rawEnd] = base.split("-");
      if (!rawStart || !rawEnd || base.split("-").length > 2) {
        throw new Error(`Invalid cron ${range.name} range: ${base}`);
      }
      start = parseCronNumber(rawStart, range.min, range.max);
      end = parseCronNumber(rawEnd, range.min, range.max);
      if (end < start) {
        throw new Error(`Cron ${range.name} range must be ascending: ${base}`);
      }
    } else {
      start = parseCronNumber(base, range.min, range.max);
      end = start;
    }

    for (let value = start; value <= end; value += step) {
      values.add(range.name === "day of week" && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron ${range.name} field did not produce any values.`);
  }
  return values;
}

function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      "Cron expressions must have five fields: minute hour day-of-month month day-of-week.",
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return {
    minutes: expandCronField(minute, CRON_FIELD_RANGES[0]),
    hours: expandCronField(hour, CRON_FIELD_RANGES[1]),
    daysOfMonth: expandCronField(dayOfMonth, CRON_FIELD_RANGES[2]),
    months: expandCronField(month, CRON_FIELD_RANGES[3]),
    daysOfWeek: expandCronField(dayOfWeek, CRON_FIELD_RANGES[4]),
    dayOfMonthWildcard: dayOfMonth === "*",
    dayOfWeekWildcard: dayOfWeek === "*",
  };
}

function cronMatchesDay(expression: ParsedCronExpression, date: Date): boolean {
  const dayOfMonthMatches = expression.daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = expression.daysOfWeek.has(date.getDay());
  if (expression.dayOfMonthWildcard && expression.dayOfWeekWildcard) {
    return true;
  }
  if (expression.dayOfMonthWildcard) {
    return dayOfWeekMatches;
  }
  if (expression.dayOfWeekWildcard) {
    return dayOfMonthMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

function cronMatches(expression: ParsedCronExpression, date: Date): boolean {
  return (
    expression.minutes.has(date.getMinutes()) &&
    expression.hours.has(date.getHours()) &&
    expression.months.has(date.getMonth() + 1) &&
    cronMatchesDay(expression, date)
  );
}

function toNextMinute(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return next;
}

export function normalizeCronExpression(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  parseCronExpression(normalized);
  return normalized;
}

export function getNextCronRunAt(
  expression: string,
  after: Date = new Date(),
): Date {
  const parsed = parseCronExpression(expression);
  const candidate = toNextMinute(after);
  const deadline = new Date(after);
  deadline.setFullYear(deadline.getFullYear() + 5);

  while (candidate <= deadline) {
    if (cronMatches(parsed, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No matching cron time was found in the next five years.`);
}
