'use client';

import {
  createColumnHelper,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from '@tanstack/react-table';
import { Reveal } from '@/components/animated';
import { EmptyState } from '@/components/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { itemEnter } from '@/lib/motion';

// Paging, filtering and sorting happen on the server, so the table needs no optional features.
const features = tableFeatures({});

export type Columns<T extends RowData> = ColumnDef<typeof features, T>[];
export const columnHelper = <T extends RowData>() => createColumnHelper<typeof features, T>();

type Props<T extends RowData> = {
  columns: Columns<T>;
  data: T[];
  empty: string;
  /** Column ids that only fit on very wide screens (2xl and up). */
  wideOnly?: string[];
  /** Extra classes per column id, e.g. to hide a column below a breakpoint. */
  columnClass?: Record<string, string>;
};

const WIDE_ONLY = 'hidden 2xl:table-cell';

export function DataTable<T extends RowData>({
  columns,
  data,
  empty,
  wideOnly = [],
  columnClass = {},
}: Props<T>) {
  const classOf = (id: string) => (wideOnly.includes(id) ? WIDE_ONLY : columnClass[id]);
  const table = useTable({ features, columns, data });
  const rows = table.getRowModel().rows;
  return (
    <Reveal>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} className={classOf(header.column.id)}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>
                <EmptyState text={empty} />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow key={row.id} className="hover:bg-raised/50" {...itemEnter(index)}>
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className={classOf(cell.column.id)}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Reveal>
  );
}
