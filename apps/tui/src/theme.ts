import { Chalk } from "chalk";
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";

const chalk = new Chalk({ level: 3 });

export const palette = {
  accent: (s: string) => chalk.hex("#8be9fd")(s),
  accentBold: (s: string) => chalk.bold.hex("#8be9fd")(s),
  muted: (s: string) => chalk.dim(s),
  faint: (s: string) => chalk.hex("#6272a4")(s),
  label: (s: string) => chalk.bold.hex("#bd93f9")(s),
  good: (s: string) => chalk.hex("#50fa7b")(s),
  warn: (s: string) => chalk.hex("#ffb86c")(s),
  bad: (s: string) => chalk.hex("#ff5555")(s),
  agent: (s: string) => chalk.hex("#ff79c6")(s),
  human: (s: string) => chalk.hex("#8be9fd")(s),
  system: (s: string) => chalk.hex("#bd93f9")(s),
  badge: (s: string) => chalk.bgHex("#44475a").hex("#f8f8f2")(s),
  badgeActive: (s: string) => chalk.bgHex("#bd93f9").hex("#282a36").bold(s),
  panelBorder: (s: string) => chalk.hex("#44475a")(s),
  bgPanel: (s: string) => chalk.bgHex("#21222c")(s),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s: string) => chalk.hex("#8be9fd")(s),
  selectedText: (s: string) => chalk.bold(s),
  description: (s: string) => chalk.dim(s),
  scrollInfo: (s: string) => chalk.dim(s),
  noMatch: (s: string) => chalk.dim(s),
};

export const editorTheme: EditorTheme = {
  borderColor: (s: string) => chalk.hex("#44475a")(s),
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (s: string) => chalk.bold.hex("#8be9fd")(s),
  link: (s: string) => chalk.hex("#8be9fd")(s),
  linkUrl: (s: string) => chalk.dim(s),
  code: (s: string) => chalk.hex("#f1fa8c")(s),
  codeBlock: (s: string) => chalk.hex("#50fa7b")(s),
  codeBlockBorder: (s: string) => chalk.dim(s),
  quote: (s: string) => chalk.italic.hex("#bd93f9")(s),
  quoteBorder: (s: string) => chalk.dim(s),
  hr: (s: string) => chalk.dim(s),
  listBullet: (s: string) => chalk.hex("#8be9fd")(s),
  bold: (s: string) => chalk.bold(s),
  italic: (s: string) => chalk.italic(s),
  strikethrough: (s: string) => chalk.strikethrough(s),
  underline: (s: string) => chalk.underline(s),
};

export function actorColor(kind: string): (s: string) => string {
  switch (kind) {
    case "human":
      return palette.human;
    case "agent":
      return palette.agent;
    case "system":
      return palette.system;
    case "connector":
      return palette.warn;
    default:
      return palette.muted;
  }
}

export function statusColor(status: string): (s: string) => string {
  if (
    ["online", "working", "done", "ready-for-review", "approved", "merged"].includes(
      status,
    )
  )
    return palette.good;
  if (
    ["blocked", "failed", "needs-human", "changes-requested", "canceled"].includes(
      status,
    )
  )
    return palette.bad;
  if (["waiting", "idle", "stopped", "reviewing"].includes(status))
    return palette.warn;
  return palette.muted;
}
