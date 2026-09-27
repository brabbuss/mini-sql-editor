import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Column } from '../../../shared/api';
import {
  assignColors,
  barLimit,
  chartData,
  isIntegerType,
  isNumericType,
  isTimeType,
  suggestChart,
  timeTickLabel,
  yTickCount
} from './chart';

const column = (name: string, type: string): Column => ({ name, type });

describe('isNumericType', () => {
  it('recognises integers, floats and decimals, wrapped or not', () => {
    for (const type of [
      'Int8',
      'UInt64',
      'Int256',
      'Float32',
      'Decimal(18, 2)',
      'Nullable(Int32)',
      'LowCardinality(Nullable(Float64))'
    ]) {
      assert.equal(isNumericType(type), true, type);
    }
  });

  it("doesn't treat other types as numbers", () => {
    for (const type of [
      'String',
      'Bool',
      'Date',
      "DateTime('UTC')",
      'Array(UInt8)',
      "Enum8('a' = 1)",
      'UUID',
      'IPv4'
    ]) {
      assert.equal(isNumericType(type), false, type);
    }
  });
});

describe('isIntegerType', () => {
  it('recognises integers, wrapped or not', () => {
    for (const type of ['Int8', 'UInt64', 'Int256', 'Nullable(UInt32)', 'LowCardinality(Nullable(Int64))']) {
      assert.equal(isIntegerType(type), true, type);
    }
  });

  // An axis of counts shouldn't have a tick at 1.5
  it("doesn't treat floats, decimals or other types as integers", () => {
    for (const type of ['Float64', 'Decimal(18, 2)', 'String', 'DateTime']) {
      assert.equal(isIntegerType(type), false, type);
    }
  });
});

describe('isTimeType', () => {
  it('recognises dates and date-times, with precision, timezone or Nullable', () => {
    for (const type of [
      'Date',
      'Date32',
      'DateTime',
      "DateTime('UTC')",
      'DateTime64(3)',
      "DateTime64(3, 'UTC')",
      'Nullable(Date)'
    ]) {
      assert.equal(isTimeType(type), true, type);
    }
  });

  it("doesn't treat other types as time", () => {
    for (const type of ['String', 'Int32', 'UUID']) {
      assert.equal(isTimeType(type), false, type);
    }
  });
});

describe('suggestChart', () => {
  it('charts numbers per category as bars', () => {
    assert.deepEqual(suggestChart([column('name', 'String'), column('count', 'UInt64')]), {
      x: 0,
      y: [1],
      form: 'bar'
    });
  });

  it('charts numbers over time as lines, preferring the time column for x', () => {
    const columns = [
      column('host', 'String'),
      column('day', 'Date'),
      column('hits', 'UInt64'),
      column('avg', 'Float64')
    ];

    assert.deepEqual(suggestChart(columns), { x: 1, y: [2], form: 'line' });
  });

  it('uses the first column as x when every column is a number', () => {
    assert.deepEqual(suggestChart([column('number', 'UInt64'), column('squared', 'UInt64')]), {
      x: 0,
      y: [1],
      form: 'line'
    });
  });

  it('plots a single numeric column against the row number', () => {
    assert.deepEqual(suggestChart([column('n', 'UInt64')]), { x: null, y: [0], form: 'line' });
  });

  // Numeric columns often measure different things at different scales; on one shared axis the smaller would be flat
  it('starts with one series, however many numeric columns there are', () => {
    const columns = [column('name', 'String'), ...Array.from({ length: 8 }, (_, i) => column(`m${i}`, 'Float64'))];

    assert.deepEqual(suggestChart(columns)?.y, [1]);
  });

  it('has nothing to chart without a numeric column', () => {
    assert.equal(suggestChart([column('a', 'String'), column('b', 'Date')]), undefined);
  });
});

describe('chartData', () => {
  const columns = [column('name', 'String'), column('big', 'UInt64'), column('ratio', 'Nullable(Float64)')];

  it('keys each series by its column, turning 64-bit integers (sent as strings) into numbers', () => {
    const { data } = chartData(columns, [['a', '9007199254740993', 0.5]], { x: 0, y: [1, 2] });

    assert.deepEqual(data, [{ x: 'a', s1: 9007199254740992, s2: 0.5 }]);
  });

  it('leaves a gap for NULL (and for NaN or infinity, which ClickHouse sends as null)', () => {
    const { data } = chartData(columns, [['a', '1', null]], { x: 0, y: [2] });

    assert.deepEqual(data, [{ x: 'a', s2: null }]);
  });

  it('numbers the rows from 1 when x is the row number', () => {
    const { data } = chartData([column('n', 'UInt64')], [['5'], ['7']], { x: null, y: [0] });

    assert.deepEqual(data, [
      { x: 1, s0: 5 },
      { x: 2, s0: 7 }
    ]);
  });

  it('shows NULL on the x axis as the text NULL', () => {
    assert.equal(chartData(columns, [[null, '1', 1]], { x: 0, y: [1] }).data[0].x, 'NULL');
  });

  it('keeps the first rows up to the limit, and says when it cut', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`r${i}`, String(i), i]);

    const limited = chartData(columns, rows, { x: 0, y: [1] }, 3);
    const whole = chartData(columns, rows, { x: 0, y: [1] }, 5);

    assert.equal(limited.data.length, 3);
    assert.equal(limited.limited, true);
    assert.equal(whole.limited, false);
  });
});

describe('assignColors', () => {
  it('gives new series the first free color, in order', () => {
    assert.deepEqual(
      assignColors(new Map(), [4, 2]),
      new Map([
        [4, 0],
        [2, 1]
      ])
    );
  });

  // Color follows the column, never its position: removing a series mustn't repaint the others
  it('keeps the colors of series that stay, and reuses freed ones', () => {
    const before = new Map([
      [1, 0],
      [2, 1],
      [3, 2]
    ]);

    assert.deepEqual(
      assignColors(before, [1, 3]),
      new Map([
        [1, 0],
        [3, 2]
      ])
    );
    assert.deepEqual(
      assignColors(
        new Map([
          [1, 0],
          [3, 2]
        ]),
        [1, 3, 5]
      ),
      new Map([
        [1, 0],
        [3, 2],
        [5, 1]
      ])
    );
  });
});

describe('barLimit', () => {
  // About 5 px per bar, however wide the plot: a phone shows fewer bars, a large monitor more
  it('fits as many bars as the width allows', () => {
    assert.equal(barLimit(350), 70);
    assert.equal(barLimit(1100), 220);
    assert.equal(barLimit(2400), 480);
  });

  it('uses 200 until the plot has been measured', () => {
    assert.equal(barLimit(0), 200);
    assert.equal(barLimit(-104), 200);
  });

  it('always shows a few bars, even in a very narrow plot', () => {
    assert.equal(barLimit(20), 10);
  });
});

describe('timeTickLabel', () => {
  // A full timestamp on every tick is too wide to fit many, and mostly repeats what the points share
  it('leaves out the date when every point is on the same day', () => {
    const label = timeTickLabel(['2026-01-05 09:00:00', '2026-01-05 09:01:30']);

    assert.equal(label('2026-01-05 09:01:30'), '09:01:30');
  });

  it('leaves out the seconds when they are all :00', () => {
    const label = timeTickLabel(['2026-01-05 09:00:00', '2026-01-05 10:00:00']);

    assert.equal(label('2026-01-05 10:00:00'), '10:00');
  });

  it('keeps the date when the points span several days', () => {
    const label = timeTickLabel(['2026-01-05 23:00:00', '2026-01-06 01:00:00']);

    assert.equal(label('2026-01-06 01:00:00'), '2026-01-06 01:00');
  });

  it('keeps fractions of a second', () => {
    const label = timeTickLabel(['2026-01-05 09:00:00.250', '2026-01-05 09:00:00.500']);

    assert.equal(label('2026-01-05 09:00:00.500'), '09:00:00.500');
  });

  it('shows dates, and anything it can’t read, as sent', () => {
    assert.equal(timeTickLabel(['2026-01-05', '2026-01-06'])('2026-01-06'), '2026-01-06');
    // One unreadable value (a NULL) and nothing is shortened: the labels stay consistent
    const label = timeTickLabel(['2026-01-05 09:00:00', 'NULL']);
    assert.equal(label('2026-01-05 09:00:00'), '2026-01-05 09:00:00');
    assert.equal(label('NULL'), 'NULL');
  });
});

describe('yTickCount', () => {
  // Five whole-number ticks for a maximum of 2 run to 4, leaving half the plot empty
  it('asks for one tick per whole number when integers span fewer than five', () => {
    assert.equal(yTickCount([1, 2, 1], true), 3);
    assert.equal(yTickCount([-1, 1], true), 3);
    assert.equal(yTickCount([0, null, 0], true), 2);
  });

  it('asks for the usual five otherwise', () => {
    assert.equal(yTickCount([0, 537], true), 5);
    assert.equal(yTickCount([-2, 2], true), 5);
    assert.equal(yTickCount([0.5, 1.5], false), 5);
  });
});
