import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cn } from '@/components/ui/cn';

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Minimum width so dense tables scroll horizontally instead of squashing. */
  minWidth?: number;
  /** Caption announced by assistive technology; visually hidden. */
  caption?: string;
}

/**
 * Data table (C10: hairline row borders, 11px uppercase column labels).
 *
 * The wrapper clips the rounded corners and scrolls horizontally, so a wide logs
 * table never breaks the page layout on a narrow screen.
 */
export function Table({ minWidth, caption, className, children, ...rest }: TableProps): ReactNode {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn('w-full border-collapse text-left align-middle text-sm', className)}
        style={minWidth ? { minWidth: `${minWidth}px` } : undefined}
        {...rest}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return (
    <thead className={cn('border-b border-border', className)} {...rest}>
      {children}
    </thead>
  );
}

export function TableBody({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return (
    <tbody className={cn('divide-y divide-border', className)} {...rest}>
      {children}
    </tbody>
  );
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Faint background on hover; enabled for tables with row actions. */
  hover?: boolean;
}

export function TableRow({ hover = false, className, children, ...rest }: TableRowProps): ReactNode {
  return (
    <tr
      className={cn(hover && 'transition-colors duration-100 hover:bg-surface-2/70', className)}
      {...rest}
    >
      {children}
    </tr>
  );
}

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
}

export function TableHead({ align = 'left', className, children, ...rest }: TableHeadProps): ReactNode {
  return (
    <th
      scope="col"
      className={cn(
        'label-caps whitespace-nowrap px-3 py-2 font-semibold',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  /** Numeric content gets tabular figures so columns line up. */
  numeric?: boolean;
}

export function TableCell({ align = 'left', numeric = false, className, children, ...rest }: TableCellProps): ReactNode {
  return (
    <td
      className={cn(
        'px-3 py-2.5 align-middle text-sm text-text',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        numeric && 'tabular',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/** In-table placeholder row that keeps the header visible while a table is empty. */
export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }): ReactNode {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-muted">
        {children}
      </td>
    </tr>
  );
}
