import { ComponentProps, useMemo } from 'react';
import { Grid } from '@clickhouse/click-ui';
import { Column } from '../../../shared/api';
import { formatCellValue } from './results';

type GridCell = ComponentProps<typeof Grid>['cell'];

interface ResultsGridProps {
  columns: Column[];
  /** Arrays in column order, as the server sends them */
  rows: unknown[][];
}

/**
 * Query results use click-ui's Grid: it's virtualized, so large results stay fast,
 * and it has spreadsheet-style selection and copying
 */
export function ResultsGrid({ columns, rows }: ResultsGridProps) {
  // Grid renders this in place of its own styled cell. Its className, style and data-* attributes (styling,
  // selection, copying) must reach the root element; the positional props are for us, not the DOM.
  const Cell = useMemo<GridCell>(
    () =>
      // Grid only knows the row and column counts and asks a cell component to render each visible cell.
      // click-ui's Table takes the data directly instead, but renders every row up front, which is slow for large results
      function Cell(cellProps) {
        const { type, columnIndex, rowIndex, isScrolling: _isScrolling, width: _width, ...domProps } = cellProps;
        const column = columns[columnIndex];
        if (type === 'header-cell') {
          return (
            <div {...domProps} title={`${column.name} (${column.type})`}>
              {column.name} <span className="results-grid__type">{column.type}</span>
            </div>
          );
        }
        const value = rows[rowIndex][columnIndex];
        const text = formatCellValue(value);
        return (
          <div {...domProps} title={text}>
            {value === null ? <span className="results-grid__null">{text}</span> : text}
          </div>
        );
      },
    [columns, rows]
  );

  return (
    <div className="results-grid">
      <Grid rowCount={rows.length} columnCount={columns.length} cell={Cell} showRowNumber />
    </div>
  );
}
