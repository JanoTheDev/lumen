// The app's icon set: named lucide imports only, so unused icons are tree-shaken.
// Icons are decorative by default; pair them with visible text or an aria-label.
import type { ComponentType, SVGProps } from 'react'
import {
  Accessibility,
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  ExternalLink,
  Hand,
  Info,
  KeyRound,
  Mic,
  MousePointer2,
  MousePointerClick,
  Palette,
  Pause,
  Pin,
  Play,
  RotateCcw,
  Search,
  Settings,
  Shield,
  Trash2,
  X,
  XOctagon
} from 'lucide-react'

type LucideLike = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }
>

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string }
export type IconComponent = (props: IconProps) => JSX.Element

function make(C: LucideLike): IconComponent {
  const Icon = ({ size = '1.25em', ...rest }: IconProps): JSX.Element => (
    <C aria-hidden="true" focusable="false" size={size} strokeWidth={1.75} {...rest} />
  )
  return Icon
}

export const icons = {
  accessibility: make(Accessibility),
  alert: make(AlertTriangle),
  book: make(BookOpen),
  brain: make(Brain),
  check: make(Check),
  checkCircle: make(CheckCircle2),
  chevronRight: make(ChevronRight),
  copy: make(Copy),
  cpu: make(Cpu),
  external: make(ExternalLink),
  hand: make(Hand),
  info: make(Info),
  key: make(KeyRound),
  mic: make(Mic),
  pointer: make(MousePointer2),
  click: make(MousePointerClick),
  palette: make(Palette),
  pause: make(Pause),
  pin: make(Pin),
  play: make(Play),
  repeat: make(RotateCcw),
  search: make(Search),
  settings: make(Settings),
  shield: make(Shield),
  trash: make(Trash2),
  close: make(X),
  error: make(XOctagon)
}

export type IconName = keyof typeof icons
