import { Column } from '../../../shared/api';

export type ChartForm = 'line' | 'bar';

export interface ChartSettings {
  /** The x-axis column, or null for the row number (a result with a single, numeric column) */
  x: number | null;
  /** The numeric columns drawn as series */
  y: number[];
  form: ChartForm;
}

/** Most series in one chart: more lines or bar groups than this can't be told apart */
export const MAX_SERIES = 5;

/** Narrowest bar still readable as a bar; below this a bar chart is a smear */
const MIN_BAR_WIDTH_PX = 5;
/** Bars shown until the plot has been measured */
const DEFAULT_BAR_LIMIT = 200;
const MIN_BARS = 10;

/**
 * How many bars fit `width` px of drawable plot, at ~MIN_BAR_WIDTH_PX each: a phone shows fewer, a large monitor more.
 * For readability, not speed (measured in Chrome: 200 bars draw in 17 ms, 1,000 in 41 ms, 5,000 in 227 ms). A width of
 * 0 or less means not measured yet.
 */
export function barLimit(width: number): number {
  return width > 0 ? Math.max(MIN_BARS, Math.floor(width / MIN_BAR_WIDTH_PX)) : DEFAULT_BAR_LIMIT;
}

// Nullable(T) is T that may be NULL; LowCardinality(T) is T stored with a dictionary. Either way the values are T's
// (and they nest: LowCardinality(Nullable(Float64))), so type checks look inside them
function unwrap(type: string): string {
  const wrapped = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(type);
  return wrapped ? unwrap(wrapped[1]) : type;
}

/** Integers, floats and decimals. Bool isn't: true/false isn't a quantity */
export function isNumericType(type: string): boolean {
  return /^(U?Int(8|16|32|64|128|256)|Float(32|64)|Decimal(32|64|128|256)?(\(.*\))?)$/.test(unwrap(type));
}

/** Integers only: an axis of counts gets whole-number ticks */
export function isIntegerType(type: string): boolean {
  return /^U?Int(8|16|32|64|128|256)$/.test(unwrap(type));
}

/** Date, Date32, DateTime and DateTime64, with or without precision and timezone */
export function isTimeType(type: string): boolean {
  return /^(Date|Date32|DateTime|DateTime64)(\(.*\))?$/.test(unwrap(type));
}

/** Recharts' default number of y ticks */
const Y_TICKS = 5;

/**
 * How many y ticks to ask Recharts for, given the plotted values. With whole-number ticks it still makes five, so
 * counts of at most 2 got an axis running to 4 and a half-empty plot: when the values span fewer than five whole
 * numbers, it's one tick each. The axis includes 0, as Recharts' does
 */
export function yTickCount(values: (number | null)[], integer: boolean): number {
  if (!integer) {
    return Y_TICKS;
  }
  let min = 0;
  let max = 0;
  for (const value of values) {
    if (value !== null) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return Math.max(2, Math.min(Y_TICKS, Math.ceil(max) - Math.floor(min) + 1));
}

// How ClickHouse sends a DateTime or DateTime64: date, hours and minutes, seconds (with any fraction)
const DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2}(?:\.\d+)?)$/;

/**
 * Tick labels for a time x axis, given every x value. A full timestamp on each tick is too wide to fit many and mostly
 * repeats what the points share, so the date is left out when they're all on one day, and the seconds when they're
 * all :00. When any value isn't a plain date-time (a Date, a NULL), labels are shown as sent. The tooltip keeps the
 * full value
 */
export function timeTickLabel(values: unknown[]): (value: unknown) => string {
  const parts = values.map((value) => (typeof value === 'string' ? DATE_TIME.exec(value) : null));
  if (parts.length === 0 || parts.some((part) => part === null)) {
    return (value) => String(value);
  }
  const readable = parts as RegExpExecArray[];
  const oneDay = readable.every((part) => part[1] === readable[0][1]);
  const wholeMinutes = readable.every((part) => part[3] === ':00');
  return (value) => {
    const part = typeof value === 'string' ? DATE_TIME.exec(value) : null;
    if (!part) {
      return String(value);
    }
    return `${oneDay ? '' : `${part[1]} `}${part[2]}${wholeMinutes ? '' : part[3]}`;
  };
}

/**
 * The chart a result most likely calls for, or undefined when there's nothing numeric to chart.
 */
export function suggestChart(columns: Column[]): ChartSettings | undefined {
  const numeric = columns.flatMap((column, i) => (isNumericType(column.type) ? [i] : []));
  if (numeric.length === 0) {
    return undefined;
  }
  const time = columns.findIndex((column) => isTimeType(column.type));
  const category = columns.findIndex((column) => !isNumericType(column.type));
  // x: a time column if there is one (a time series is the commonest chart),
  // else the first column that isn't a number, else the first column;
  // a single numeric column is plotted against the row number.
  // y: the first other numeric column only: numeric columns often measure different things at different scales
  // (hits ~300, latency ~10), and on one shared axis the smaller would be flattened; the user adds more.
  // A line over time or numbers, bars per category.
  const x = time !== -1 ? time : category !== -1 ? category : numeric.length > 1 ? numeric[0] : null;
  const y = numeric.filter((i) => i !== x).slice(0, 1);
  const continuous = x === null || isTimeType(columns[x].type) || isNumericType(columns[x].type);
  return { x, y, form: continuous ? 'line' : 'bar' };
}

// 64-bit and larger integers arrive as strings (JSON numbers can't hold them exactly); beyond 2^53 they lose
// precision here, which a chart can't show anyway. Anything unreadable is a gap, like NULL
function toNumber(value: unknown): number | null {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function toLabel(value: unknown): string | number {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  return typeof value === 'number' ? value : typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The first `limit` rows as chart points: `x`, and one key per series, `s<column index>`, so a series keeps its key
 * (and color) whichever others are shown. `limited` says whether rows were left out.
 */
export function chartData(
  columns: Column[],
  rows: unknown[][],
  { x, y }: Pick<ChartSettings, 'x' | 'y'>,
  limit = rows.length
) {
  const numericX = x !== null && isNumericType(columns[x].type);
  const data = rows.slice(0, limit).map((row, i) => {
    const point: Record<string, unknown> = { x: x === null ? i + 1 : numericX ? toNumber(row[x]) : toLabel(row[x]) };
    for (const column of y) {
      point[`s${column}`] = toNumber(row[column]);
    }
    return point;
  });
  return { data, limited: rows.length > limit };
}

/**
 * Colors by column, not by position: series that stay keep their color when others are added or removed, and a new
 * series takes the first free one. Returns column → color slot (0 … MAX_SERIES - 1).
 */
export function assignColors(previous: Map<number, number>, y: number[]): Map<number, number> {
  const colors = new Map<number, number>();
  for (const column of y) {
    const slot = previous.get(column);
    if (slot !== undefined) {
      colors.set(column, slot);
    }
  }
  for (const column of y) {
    if (!colors.has(column)) {
      const used = new Set(colors.values());
      let slot = 0;
      while (used.has(slot)) {
        slot++;
      }
      colors.set(column, slot);
    }
  }
  return colors;
}
