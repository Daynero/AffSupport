/**
 * The component inventory (021).
 *
 * Forty-five named components, thirty-three of them mapped onto Nuxt UI's
 * catalogue and twelve product-specific. Screens import from here; the older
 * `components/ui.tsx` re-exports this file, so the sixty modules that already
 * import from that path keep working while their screens migrate.
 *
 * The contract for all of it is in
 * `specs/021-design-system-redesign/contracts/components.md`.
 */

export { UI_COLORS, UI_SIZES, UI_VARIANTS, uiClasses } from './types';
export type { UiColor, UiSize, UiVariant } from './types';

export { Button, IconButton } from './Button';
export type { ButtonProps, IconButtonProps } from './Button';

export { Badge, Chip } from './Badge';
export type { BadgeProps, ChipProps } from './Badge';

export { Card, Separator } from './Card';
export type { CardProps, CardRole, SeparatorProps } from './Card';

export { Alert } from './Alert';
export type { AlertProps } from './Alert';

export { FormField, Input, InputNumber, InputTags, Select, Textarea } from './Field';
export type {
  FieldProps,
  InputNumberProps,
  InputProps,
  InputTagsProps,
  SelectProps,
  TextareaProps
} from './Field';

export { Checkbox, RadioGroup, SegmentedControl, Slider, Switch } from './Choice';
export type {
  CheckboxProps,
  RadioGroupProps,
  RadioOption,
  SegmentedControlProps,
  SliderProps,
  SwitchProps
} from './Choice';

export { Empty, Progress, Skeleton, Spinner, Tooltip } from './Feedback';
export type { EmptyProps, ProgressProps, SkeletonProps, TooltipProps } from './Feedback';

export { Drawer, DropdownMenu, Modal, Popover } from './Overlay';
export type {
  DrawerProps,
  DropdownMenuProps,
  MenuItem,
  ModalProps,
  PopoverProps
} from './Overlay';

export { Breadcrumb, Link, Pagination, Tabs } from './Navigation';
export type {
  BreadcrumbProps,
  Crumb,
  LinkProps,
  PaginationProps,
  TabItem,
  TabsProps
} from './Navigation';

export {
  Accordion,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Timeline,
  Tree,
  User
} from './Table';
export type {
  AccordionItem,
  AccordionProps,
  TableProps,
  TableRowProps,
  TimelineEntry,
  TreeNode,
  TreeProps,
  UserProps
} from './Table';

export {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PermissionState,
  SelectionBar
} from './patterns';
export type {
  ConfirmDialogProps,
  EmptyStateProps,
  ErrorStateProps,
  LoadingStateProps,
  PermissionStateProps,
  SelectionBarProps
} from './patterns';
