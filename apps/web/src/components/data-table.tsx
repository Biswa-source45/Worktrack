'use client';

import {
  createColumnHelper,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Paging, filtering and sorting happen on the server, so the table needs no optional features.
const features = tableFeatures({});

export type Columns<T extends RowData> = ColumnDef<typeof features, T>[];
export const columnHelper = <T extends RowData>() => createColumnHelper<typeof features, T>();

type Props<T extends RowData> = { columns: Columns<T>; data: T[]; empty: string };

export function DataTable<T extends RowData>({ columns, data, empty }: Props<T>) {
  const table = useTable({ features, columns, data });
  const rows = table.getRowModel().rows;
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
