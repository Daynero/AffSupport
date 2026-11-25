/**
 * The component inventory (021).
 *
 * Forty-five named components, thirty-three of them mapped onto Nuxt UI's
 * catalogue and twelve product-specific. Screens import from here. The pre-021
 * shim that stood beside it, `components/ui.tsx`, was deleted by 070 T065, so
 * `components/ui` and `components/ui/index` now name the same module.
 *
 * The contract for all of it is in
 * `specs/021-design-system-redesign/contracts/components.md`.
 */

export { UI_COLORS, UI_SIZES, UI_VARIANTS, fillRatio, uiClasses } from './types';
export type { UiColor, UiSize, UiVariant } from './types';

export { Button, IconButton } from './Button';
export {
  HoldToConfirmButton,
  DESTRUCTIVE_HOLD_MS,
  SPACE_DELETE_HOLD_MS
} from './HoldToConfirmButton';
export type { HoldDuration } from './HoldToConfirmButton';
export type { ButtonProps, IconButtonProps } from './Button';

export { Badge, Chip } from './Badge';
export type { BadgeProps, ChipProps } from './Badge';

export { Card, Separator } from './Card';
export type { CardProps, CardRole, SeparatorProps } from './Card';

export { Alert } from './Alert';
export { TimeWheel } from './TimeWheel';
export type { AlertProps } from './Alert';

export {
  FormField,
  Input,
  InputNumber,
  InputTags,
  Select,
  SelectMenu,
  SearchField,
  Textarea
} from './Field';
export type {
  FieldProps,
  InputNumberProps,
  InputProps,
  InputTagsProps,
  SelectProps,
  SearchFieldProps,
  TextareaProps
} from './Field';

/* The way into the file system (070): a pressable opens the picker; a menu item opens it through the ref. */
export { FileTrigger } from './FileTrigger';
export type { FileTriggerHandle, FileTriggerProps } from './FileTrigger';

export { Checkbox, RadioGroup, SegmentedControl, Slider, Switch } from './Choice';
/* One picto that is on or off, pressable while it explains why it cannot act (070, phase 8б). */
export { PictoToggle } from './PictoToggle';
export type { PictoToggleProps } from './PictoToggle';
export type {
  CheckboxProps,
  RadioGroupProps,
  RadioOption,
  SegmentedControlProps,
  SliderProps,
  SwitchProps
} from './Choice';

export {
  Collapse,
  Empty,
  FadeImage,
  Progress,
  Reveal,
  RouteSkeleton,
  Skeleton,
  Spinner,
  Tooltip
} from './Feedback';
/* The "?" beside a setting's name (070, T035). */
export { HelpTip } from './HelpTip';
/* The hint behind every `title` (070, T033). */
export { HintLayer } from './HintLayer';
export type {
  CollapseProps,
  EmptyProps,
  ProgressProps,
  RevealProps,
  RouteSkeletonProps,
  SkeletonProps,
  TooltipProps
} from './Feedback';

export { Drawer, DropdownMenu, Modal, Popover } from './Overlay';
export type {
  DialogBehaviour,
  DrawerProps,
  DropdownMenuProps,
  MenuEntry,
  MenuHeading,
  MenuItem,
  ModalProps,
  PopoverProps
} from './Overlay';
export { useDialogBehaviour } from './Overlay';

/* The movable edge between two panes (070). */
export { Splitter } from './Splitter';
export type { SplitterProps } from './Splitter';

export { Breadcrumb, Link, Pagination, Tabs, Toolbar } from './Navigation';
/* A row of actions that gives up words before room, measured rather than guessed (070 T034). */
export { useCompactToolbar, useToolbarStages } from './useCompactToolbar';
export type {
  CompactToolbar,
  ToolbarStage,
  ToolbarStages,
  ToolbarStagesOptions
} from './useCompactToolbar';
export type {
  BreadcrumbProps,
  Crumb,
  LinkProps,
  PaginationProps,
  TabItem,
  TabsProps,
  ToolbarProps
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
  TableHeaderCellProps,
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

/* Dates (024): one calendar for the whole product, on React Aria. */
export {
  Calendar,
  RangeCalendar,
  toCalendarDate,
  fromCalendarDate,
  todayHere,
  type CalendarProps,
  type RangeCalendarProps,
  type DateRange
} from './DateField';

export { DurationSlider } from './DurationSlider';
export { RestitchDurationControl } from './RestitchDurationControl';
export type {
  RestitchDurationValue,
  RestitchDurationControlProps
} from './RestitchDurationControl';
/* A re-stitched video as a strip: first frame, video, final picture to scale (071). */
export { RestitchTimeline } from './RestitchTimeline';
export type {
  RestitchTimelineLabels,
  RestitchTimelineEnd,
  RestitchTimelineProps,
  RestitchTimelineSlot
} from './RestitchTimeline';
export {
  FINAL_MAX_MINUTES,
  FINAL_MIN_MINUTES,
  clampMinutes,
  exactDuration,
  spanText
} from './restitch-timeline-scale';
export type { FinalDuration, FinalHandle } from './restitch-timeline-scale';
export { StageProgress, type ProgressStage } from './StageProgress';
