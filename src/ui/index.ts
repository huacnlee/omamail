// The app's ui layer. Features import controls from here, never from
// nsh/base or a component library directly: a look this file lacks becomes a
// new variant here first. nsh-omarchy supplies the Omarchy controls; the
// app-owned components below fill what it does not have.
// Separator has no size of its own. Omarchy is nsh-omarchy's theme API with
// `followSystem()` starting the app's Theme setting (theme.ts `AppOmarchy`).
export { Separator } from "nsh-omarchy";
export { AppOmarchy as Omarchy } from "./theme";
// nsh-omarchy controls at the base size (Controls.tsx); same props.
export {
  Button, IconButton, Input, Textarea, NumberInput, ListItem, TitleBar,
  type ButtonProps, type IconButtonProps, type InputProps, type TextareaProps,
  type NumberInputProps, type ListItemProps, type TitleBarProps,
} from "./Controls";
// nsh-omarchy's components redrawn on nsh/base so every size follows the
// base size; same props as nsh-omarchy's.
export { Checkbox, Switch, type CheckboxProps, type SwitchProps } from "./Toggles";
export { Tooltip, type TooltipProps } from "./Tooltip";
export { Tabs, Tab, type TabsProps, type TabProps, type TabsVariant } from "./Tabs";
export { Calendar, type CalendarProps, type DateRange } from "./Calendar";
export { DatePicker, dateLabel, type DatePickerProps } from "./DatePicker";
export { Toaster, toast, dismissToast, TOAST_TIMEOUT, type Toast, type ToastKind, type ToastOptions } from "./Toast";
export { confirm, ConfirmHost, type ConfirmOptions } from "./Confirm";
export { Icon, icons, iconKeyFor, type IconKey } from "./Icon";
export * from "./motion";

// App-owned components: what nsh-omarchy lacks, built on nsh/base with the
// tokens below. Each takes variants, sizes, states and slots, never colors.
export * from "./tokens";
export {
  setThemeMode, themeMode, themeReady, defaultThemeMode, isOmarchyDesktop, setOmarchyDesktop, monoFamily,
  THEME_MODES, INK, PAPER, type ThemeMode,
} from "./theme";
export { Kbd, KeyHints, keyCapLabel, keyCapParts, chordKeystroke, chordLabel, keyCaps, isApple, type KbdProps, type KeyHint, type KeyHintsProps } from "./Kbd";
export { CountBadge, UnreadDot, badgeText, type CountBadgeProps, type UnreadDotProps } from "./Counts";
export { SectionHeading, type SectionHeadingProps } from "./Section";
export { InitialAvatar, initialOf, type InitialAvatarProps, type AvatarSize } from "./InitialAvatar";
export { Notice, NoticeStack, type NoticeProps, type NoticeAction, type NoticeItem, type NoticeStackProps } from "./Notice";
export { Skeleton, SkeletonBar, ListSkeleton, ReaderSkeleton, LIST_ROW_WIDTHS, READER_BODY_WIDTHS, type SkeletonProps, type SkeletonBarProps, type ListSkeletonProps } from "./Skeleton";
export { SplitPane, SplitPanel, isResetPress, SPLIT_HIT, type SplitPaneProps, type SplitPanelProps } from "./SplitPane";
export { ActionBar, ActionBarGroup, ActionBarSeparator, ActionBarSpacer, ToolButton, type ActionBarProps, type ToolButtonProps } from "./ActionBar";
export { Spinner, LoadingRow, type SpinnerProps, type LoadingRowProps } from "./Spinner";
export { NavRow, NavList, ListRow, ThreadCount, ROW_INDENT, type NavRowProps, type NavListProps, type NavListStep, type ListRowProps, type ThreadCountProps } from "./Row";
export { ChipInput, ChipTokenView, entriesOnChange, splitEntries, type ChipInputProps, type ChipToken } from "./ChipInput";
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "./SegmentedControl";
export { EmptyPane, type EmptyPaneProps } from "./Empty";
export { confirmAction, ShortcutTooltip, MenuButton, ContextMenuArea, type ConfirmRequest, type MenuButtonProps, type ContextMenuAreaProps } from "./Overlays";
export { ControlledContextMenu, ChoiceDialog, type ControlledContextMenuProps, type ChoiceDialogProps, type Choice } from "./Overlays";
export type { TextareaRef, IconName, ControlSize, ButtonVariant } from "nsh-omarchy";
export { SplitHandle, resizedSize, SPLIT_STEP, type SplitHandleProps } from "./SplitHandle";
export { PickerRow, type PickerRowProps } from "./PickerRow";
export { TextEditor, type TextEditorProps } from "./TextEditor";
// Content renderers and refs features need without reaching past ui.
export { TextView, type TextViewImage, type TextViewRef, type TextViewStyles } from "nsh/base";
export type { InputRef as BaseInputRef } from "nsh";
export type { InputRef } from "nsh-omarchy";
export {
  followOmarchyFont,
  OMARCHY_FONT,
  BASE_SIZE,
  uiScale,
  scaled,
  fontFamily,
  setOmarchyFont,
  parseOmarchyFont,
  type OmarchyFont,
} from "./font";
export { OverlayPanel, type OverlayPanelProps } from "./OverlayPanel";
export { SettingSection, SettingRow, Hint, Disclosure, type SettingSectionProps, type SettingRowProps, type HintProps, type DisclosureProps } from "./Settings";
export { Popover, HoverCard, type PopoverProps, type HoverCardProps } from "./Popover";
export { ScrollBox, type ScrollBoxProps } from "./ScrollBox";
export { Menu, ContextMenu, MenuItem, MenuLabel, MenuSeparator, KeyCaps, type MenuProps, type ContextMenuProps, type MenuItemProps } from "./Menu";
export { Stepper, type StepperProps } from "./Stepper";
export { Titled, FinderPanel, type TitledProps, type TitledSurface, type FinderPanelProps } from "./Titled";
export { StatusPill, type StatusPillProps, type StatusPillTone } from "./StatusPill";
export { Dialog, AlertDialog, Sheet, type DialogProps, type AlertDialogProps, type SheetProps } from "./Dialog";
export { Field, FieldLabel, type FieldProps } from "./Field";
export { Select, type SelectProps, type SelectItem } from "./Select";

// Input method composition (docs/DESIGN.md "Input methods"): the shell's
// router binds no shortcuts while `imeComposing()` is true.
export { imeComposing, textInputActive, trackTextField } from "./ime";
export type { CompositionEvent, TextFieldIme } from "./ime";
export { restingIndex, rovingMove, useRovingFocus } from "./roving";
export type { RovingFocus, RovingFocusOptions, RovingKey, RovingKeyBinder, RovingMove, RovingTarget } from "./roving";
export { escapeMayClose, imeSafe, overlayOpen, trackOverlay, useEscapeToClose } from "./overlays-stack";
export { quickActionsA11y, slotChord, type RowQuickAction } from "./Row";
