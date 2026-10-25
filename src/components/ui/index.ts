/**
 * Barrel for the console UI kit.
 *
 * Importing from `@/components/ui` keeps pages readable; every primitive is also
 * importable from its own module when tree-shaking matters.
 */

export { cn } from '@/components/ui/cn';
export { Badge, type BadgeProps, type BadgeTone } from '@/components/ui/Badge';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from '@/components/ui/Button';
export {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardHeaderProps,
  type CardProps,
  type CardTitleProps,
} from '@/components/ui/Card';
export { EmptyState, ErrorState, type EmptyStateProps, type ErrorStateProps } from '@/components/ui/EmptyState';
export { Field, Input, Textarea, type FieldProps, type InputProps, type TextareaProps } from '@/components/ui/Input';
export { Label, type LabelProps } from '@/components/ui/Label';
export { ConfirmDialog, Modal, type ConfirmDialogProps, type ModalProps } from '@/components/ui/Modal';
export { Select, toOptions, type SelectOption, type SelectProps } from '@/components/ui/Select';
export { LoadingBlock, Spinner, type LoadingBlockProps, type SpinnerProps } from '@/components/ui/Spinner';
export { Switch, type SwitchProps } from '@/components/ui/Switch';
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableMessage,
  TableRow,
  type TableCellProps,
  type TableHeadProps,
  type TableProps,
  type TableRowProps,
} from '@/components/ui/Table';
export { Tabs, type TabItem, type TabsProps } from '@/components/ui/Tabs';
export { ToastProvider, useToast, type ToastInput } from '@/components/ui/Toast';
