import { useMemo, useState } from 'react';
import { ButtonGroup, Checkbox, Select, Text } from '@clickhouse/click-ui';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { Column } from '../../../shared/api';
import {
  assignColors,
  barLimit,
  ChartForm,
  chartData,
  ChartSettings,
  isIntegerType,
  isNumericType,
  isTimeType,
  MAX_SERIES,
  timeTickLabel,
  yTickCount
} from './chart';

/**
 * click-ui's own chart colors (--click-chart-color-default-*, light theme): blue, orange, teal, fuchsia, violet.
 * Only its first five pass the colorblind and contrast checks on a white surface, which is also why a chart has at most
 * five series. Red is left out: it means "error" everywhere else in the app. Hex values, because SVG presentation
 * attributes can't read CSS variables.
 */
const SERIES_COLORS = ['#437eef', '#ff7729', '#089b83', '#fb32c9', '#bb33ff'];

// The right margin leaves room for the last x label, which is centred on the last tick (a date is ~70 px wide)
const MARGIN = { top: 8, right: 40, bottom: 8, left: 8 };
const Y_AXIS_WIDTH = 56;

const ROW_NUMBER = 'row';
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
const formatValue = (value: unknown) => (typeof value === 'number' ? full.format(value) : String(value));

/** What the user chose for a chart: its axes and form, and each series' color (see assignColors) */
export interface ChartState {
  settings: ChartSettings;
  colors: Map<number, number>;
}

/** A chart as first shown: suggestChart's pick, colored in order */
export function initialChartState(suggested: ChartSettings): ChartState {
  return { settings: suggested, colors: assignColors(new Map(), suggested.y) };
}

interface ResultsChartProps {
  columns: Column[];
  rows: unknown[][];
  /** Kept by the caller, so it outlives this component (e.g. switching to another statement's tab and back) */
  chart: ChartState;
  onChange: (chart: ChartState) => void;
}

/** A result as a line or bar chart, with the axes and form the user can change */
export function ResultsChart({ columns, rows, chart, onChange }: ResultsChartProps) {
  const { settings, colors } = chart;
  const { x, y, form } = settings;
  const setSettings = (next: ChartSettings) => onChange({ settings: next, colors });

  const setY = (next: number[]) => onChange({ settings: { ...settings, y: next }, colors: assignColors(colors, next) });
  const setX = (value: string) => {
    const nextX = value === ROW_NUMBER ? null : Number(value);
    setSettings({ ...settings, x: nextX, y: y.filter((column) => column !== nextX) });
  };

  // How many bars fit the plot's measured width (see barLimit). Kept as the count, not the width, so resizing the
  // window only re-renders when the count changes. Lines draw every row (10,000 rows x 3 series: ~0.5 s, once)
  const [fittingBars, setFittingBars] = useState(() => barLimit(0));
  const limit = form === 'bar' ? fittingBars : rows.length;
  // Up to 10,000 points: rebuilt only when what they're made of changes
  const { data, limited } = useMemo(() => chartData(columns, rows, { x, y }, limit), [columns, rows, x, y, limit]);
  const numericX = x !== null && isNumericType(columns[x].type);
  // Whole-number ticks when every plotted value is an integer: a count of 1.5 doesn't exist
  const integerX = x !== null && isIntegerType(columns[x].type);
  const integerY = y.every((column) => isIntegerType(columns[column].type));
  const timeX = x !== null && isTimeType(columns[x].type);
  const xLabel = useMemo(() => (timeX ? timeTickLabel(data.map((point) => point.x)) : undefined), [timeX, data]);
  const yTicks = useMemo(
    () => yTickCount(data.flatMap((point) => y.map((column) => point[`s${column}`] as number | null)), integerY),
    [data, y, integerY]
  );
  const choices = columns.flatMap((column, i) => (isNumericType(column.type) && i !== x ? [i] : []));

  return (
    <div className="results-chart">
      <div className="results-chart__controls">
        <div className="results-chart__x">
          <Select
            label="X axis"
            value={x === null ? ROW_NUMBER : String(x)}
            onSelect={setX}
            options={[
              { value: ROW_NUMBER, label: 'Row number' },
              ...columns.map((column, i) => ({ value: String(i), label: column.name }))
            ]}
          />
        </div>
        <fieldset className="results-chart__y">
          <legend>Y axis</legend>
          <div className="results-chart__series-list">
            {choices.map((column) => {
              const selected = y.includes(column);
              const slot = colors.get(column);
              return (
                <span key={column} className="results-chart__series">
                  <span
                    className="results-chart__swatch"
                    style={{ background: selected && slot !== undefined ? SERIES_COLORS[slot] : 'transparent' }}
                  />
                  <Checkbox
                    label={columns[column].name}
                    checked={selected}
                    // At most MAX_SERIES: the rest are disabled until one is unchecked
                    disabled={!selected && y.length >= MAX_SERIES}
                    onCheckedChange={(checked) =>
                      setY(checked === true ? [...y, column] : y.filter((other) => other !== column))
                    }
                  />
                </span>
              );
            })}
          </div>
        </fieldset>
        <ButtonGroup
          aria-label="Chart type"
          options={[
            { value: 'line', label: 'Line' },
            { value: 'bar', label: 'Bar' }
          ]}
          selected={form}
          onClick={(value) => setSettings({ ...settings, form: value as ChartForm })}
        />
      </div>
      {limited && (
        <Text size="sm" color="muted">
          {/* The first rows, not a sample or buckets: every bar is a real row, and the query's order (often ORDER BY
              count DESC) decides which. Aggregating here would invent numbers the query never asked for */}
          Showing the first {limit.toLocaleString()} of {rows.length.toLocaleString()} rows as bars (in the query&apos;s
          order): as many as fit this width. Switch to Line to see every row, or aggregate in the query (e.g.{' '}
          <code>GROUP BY … LIMIT</code>).
        </Text>
      )}
      {y.length === 0 ? (
        <Text color="muted">Pick at least one column for the Y axis.</Text>
      ) : (
        <div className="results-chart__plot">
          <ResponsiveContainer
            width="100%"
            height="100%"
            onResize={(width) => setFittingBars(barLimit(width - Y_AXIS_WIDTH - MARGIN.left - MARGIN.right))}
          >
            {form === 'line' ? (
              <LineChart data={data} margin={MARGIN}>
                {axes({ numericX, integerX, integerY, yTicks, xLabel })}
                {y.map((column) => (
                  <Line
                    key={column}
                    dataKey={`s${column}`}
                    name={columns[column].name}
                    stroke={SERIES_COLORS[colors.get(column) ?? 0]}
                    strokeWidth={2}
                    dot={false}
                    // A NULL is a gap, not a line drawn through a value that isn't there
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {legend(y.length)}
              </LineChart>
            ) : (
              <BarChart data={data} margin={MARGIN} barGap={2}>
                {axes({ numericX: false, integerX: false, integerY, yTicks, xLabel })}
                {y.map((column) => (
                  <Bar
                    key={column}
                    dataKey={`s${column}`}
                    name={columns[column].name}
                    fill={SERIES_COLORS[colors.get(column) ?? 0]}
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                ))}
                {legend(y.length)}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

interface AxisOptions {
  /** A number axis, scaled to the values; otherwise a tick per point (categories, times, row numbers) */
  numericX: boolean;
  integerX: boolean;
  integerY: boolean;
  /** See yTickCount */
  yTicks: number;
  /** Labels for a category axis (shorter times: see timeTickLabel) */
  xLabel?: (value: unknown) => string;
}

// Recessive grid and axes: horizontal lines only, muted ink
function axes({ numericX, integerX, integerY, yTicks, xLabel }: AxisOptions) {
  const tick = { fontSize: 12, fill: 'var(--click-global-color-text-muted)' };
  return [
    <CartesianGrid key="grid" vertical={false} stroke="var(--click-global-color-stroke-muted)" />,
    numericX ? (
      <XAxis
        key="x"
        dataKey="x"
        type="number"
        domain={['dataMin', 'dataMax']}
        allowDecimals={!integerX}
        tick={tick}
        tickFormatter={(v) => compact.format(v)}
      />
    ) : (
      // A tick per point, less those whose labels wouldn't fit with room between them
      <XAxis key="x" dataKey="x" type="category" tick={tick} tickFormatter={xLabel} minTickGap={16} />
    ),
    <YAxis
      key="y"
      allowDecimals={!integerY}
      tickCount={yTicks}
      tick={tick}
      tickFormatter={(v: number) => compact.format(v)}
      width={Y_AXIS_WIDTH}
    />,
    // Values in text ink, not the series color
    <Tooltip
      key="tooltip"
      formatter={formatValue}
      labelFormatter={formatValue}
      itemStyle={{ color: 'var(--click-global-color-text-default)' }}
      // Column order, like the legend
      itemSorter={(item) => Number(String(item.dataKey).slice(1))}
    />
  ];
}

// For 2+ series only (a single series is named by the Y axis choice); text in text ink, not the series color
function legend(series: number) {
  return series > 1 ? (
    <Legend
      formatter={(name) => <span className="results-chart__legend-text">{name}</span>}
      // Column order, like the checkboxes (Recharts sorts alphabetically by default); keys are s<column index>
      itemSorter={(item) => Number(String(item.dataKey).slice(1))}
    />
  ) : null;
}
