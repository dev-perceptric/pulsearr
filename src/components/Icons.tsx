import {
  Activity as LActivity,
  ArrowLeft as LArrowLeft,
  CalendarDays as LCalendarDays,
  Check as LCheck,
  ChevronDown as LChevronDown,
  ChevronLeft as LChevronLeft,
  ChevronRight as LChevronRight,
  ChevronsUpDown as LChevronsUpDown,
  Copy as LCopy,
  CreditCard as LCreditCard,
  Ellipsis as LEllipsis,
  Info as LInfo,
  KeyRound as LKeyRound,
  LayoutDashboard as LLayoutDashboard,
  LogOut as LLogOut,
  Mail as LMail,
  Menu as LMenu,
  Plug as LPlug,
  Plus as LPlus,
  RotateCw as LRotateCw,
  Search as LSearch,
  Settings as LSettings,
  Trash as LTrash,
  User as LUser,
  Users as LUsers,
  X as LX,
  type LucideIcon,
} from "lucide-react";

// The app's icons: Lucide at 1.5px stroke with square caps (docs/brand.md section 8). 16px in tables and buttons,
// 20px in navigation, 24px in empty states. Each takes a size and a className and takes the text color.

type P = { size?: number; className?: string };

function line(I: LucideIcon, name: string) {
  const Icon = ({ size = 16, className = "" }: P) => <I size={size} strokeWidth={1.5} strokeLinecap="square" strokeLinejoin="miter" className={`shrink-0 ${className}`} aria-hidden="true" />;
  Icon.displayName = name;
  return Icon;
}

export const Activity = line(LActivity, "Activity");
export const ArrowLeft = line(LArrowLeft, "ArrowLeft");
export const CalendarDays = line(LCalendarDays, "CalendarDays");
export const Check = line(LCheck, "Check");
export const ChevronDown = line(LChevronDown, "ChevronDown");
export const ChevronLeft = line(LChevronLeft, "ChevronLeft");
export const ChevronRight = line(LChevronRight, "ChevronRight");
export const ChevronsUpDown = line(LChevronsUpDown, "ChevronsUpDown");
export const Copy = line(LCopy, "Copy");
export const CreditCard = line(LCreditCard, "CreditCard");
export const Info = line(LInfo, "Info");
export const KeyRound = line(LKeyRound, "KeyRound");
export const LayoutDashboard = line(LLayoutDashboard, "LayoutDashboard");
export const LogOut = line(LLogOut, "LogOut");
export const Mail = line(LMail, "Mail");
export const Menu = line(LMenu, "Menu");
export const MoreHorizontal = line(LEllipsis, "MoreHorizontal");
export const Plug = line(LPlug, "Plug");
export const Plus = line(LPlus, "Plus");
export const Refresh = line(LRotateCw, "Refresh");
export const SearchIcon = line(LSearch, "SearchIcon");
export const Settings = line(LSettings, "Settings");
export const Trash = line(LTrash, "Trash");
export const UserIcon = line(LUser, "UserIcon");
export const Users = line(LUsers, "Users");
export const X = line(LX, "X");

/** Google's "G", in its own colors, for sign-in buttons and the Google logo. */
export function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
