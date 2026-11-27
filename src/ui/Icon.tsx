// The app's one Icon: Lucide through nsh-icon, tinted by the text color around
// it. Features name icons from `icons` below, never import a set directly, so
// the family and the meaning of each glyph are decided in one place (the role
// ui/components/Icons.js had in the Qt client).
import { Icon as NshIcon } from "nsh-icon";
import * as L from "nsh-icon-lucide";
import { scaled } from "./font";

// Lucide's Star filled in (fill and stroke in the text color): the "on" state of
// star, beside the stroked one, as Icons.js's FILLED table was in the Qt client.
const StarFilled: string = L.Star.replace("fill='none'", "fill='currentColor'");

export const icons = {
  reply: L.Reply, replyAll: L.ReplyAll, forward: L.Forward, archive: L.Archive,
  download: L.Download, trash: L.Trash2, spam: L.OctagonAlert, unread: L.Mail, read: L.MailOpen,
  star: L.Star, browser: L.ExternalLink, refresh: L.RefreshCw, send: L.Send, sent: L.Send,
  undo: L.Undo2, menu: L.Menu, plus: L.Plus, more: L.EllipsisVertical, stop: L.Square,
  copy: L.Copy, close: L.X, back: L.ArrowLeft, chevronLeft: L.ChevronLeft,
  chevronRight: L.ChevronRight, chevronDown: L.ChevronDown, chevronUp: L.ChevronUp,
  zoomIn: L.ZoomIn, zoomOut: L.ZoomOut, fit: L.Maximize, eye: L.Eye, eyeOff: L.EyeOff,
  inbox: L.Inbox, compose: L.FilePen, edit: L.Pencil, label: L.Tag, mail: L.Mail,
  sidebar: L.PanelLeft, check: L.Check, attachment: L.Paperclip, calendar: L.Calendar,
  video: L.Video, pin: L.Pin, people: L.Users, agent: L.Bot, search: L.Search,
  settings: L.Settings, drafts: L.FilePen, clock: L.Clock, folder: L.Folder, logout: L.LogOut,
  addAccount: L.UserPlus, at: L.AtSign, keyboard: L.Keyboard, info: L.Info,
  error: L.CircleAlert, warning: L.TriangleAlert, success: L.CircleCheck, loading: L.LoaderCircle,
  sun: L.Sun, moon: L.Moon, filter: L.Funnel, select: L.ListChecks, image: L.Image,
  bell: L.Bell, bellOff: L.BellOff, sparkles: L.Sparkles, translate: L.Languages,
  minus: L.Minus, file: L.File, location: L.MapPin, repeat: L.Repeat,
  addEvent: L.CalendarPlus, week: L.CalendarDays, decline: L.CircleX, grip: L.GripVertical,
  move: L.Move, block: L.Ban, unsubscribe: L.BellOff,
  printer: L.Printer, code: L.Code, text: L.FileText,
  // Compose (compose agent): a draft in a window of its own.
  window: L.AppWindow,
  // List (list agent): the starred state.
  starFilled: StarFilled,
} as const;

/** The filled form of the names that have an "on" state to show. */
const FILLED: Partial<Record<IconKey, IconKey>> = { star: "starFilled" };

export type IconKey = keyof typeof icons;

export interface IconProps {
  name: IconKey;
  /** Points; default 16, the TEXT_MD line height. */
  size?: number;
  /** What screen readers say; leave out when the text beside it says it. */
  label?: string;
  class?: string;
  /** The filled form where the name has one (`star`): an "on" state, said in the label or the button's name too. */
  filled?: boolean;
}

/** The key drawn for `name`, `filled` or not. */
export function iconKeyFor(name: IconKey, filled?: boolean): IconKey {
  return filled ? FILLED[name] ?? name : name;
}

export function Icon(props: IconProps) {
  return <NshIcon icon={icons[iconKeyFor(props.name, props.filled)]} size={scaled(props.size ?? 16)} label={props.label} class={props.class} />;
}
