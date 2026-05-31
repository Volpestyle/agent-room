import {
  Container,
  Input,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette, selectListTheme } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { View, ViewActivationContext } from "./types.js";

/** An editable setting the user selected in the Settings view. */
export type SettingsAction =
  | { kind: "token"; gatewayId: string; tokenEnv: string; label: string }
  | { kind: "channel"; routeId: string; label: string; current: string | undefined };

export interface SettingsViewOptions {
  store: DashboardStore;
  onEdit: (action: SettingsAction) => void;
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/** A single settable text line, used inside the editor overlay. */
class Line implements Component {
  constructor(private text: string) {}
  set(text: string): void {
    this.text = text;
  }
  render(width: number): string[] {
    return [fit(this.text, width)];
  }
  invalidate(): void {}
}

export interface FieldEditorOptions {
  title: string;
  hint: string;
  /** Render the value as dots (for secrets). */
  mask: boolean;
  /** Allow submitting an empty value (e.g. clearing a channel back to the default). */
  allowEmpty: boolean;
}

/**
 * Single-line editor shown as a focused overlay. Editing/paste is delegated to a
 * real Input; rendering is derived so secrets can be masked.
 */
export class FieldEditorOverlay extends Container implements Focusable {
  private readonly input = new Input();
  private readonly valueLine = new Line("");
  private readonly statusLine = new Line("");
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly options: FieldEditorOptions,
    private readonly onSubmitValue: (value: string) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed && !this.options.allowEmpty) {
        this.setError("Value cannot be empty.");
        return;
      }
      this.onSubmitValue(trimmed);
    };
    this.input.onEscape = () => this.onCancel();
    this.refreshValue();

    this.addChild(new Line(palette.label(this.options.title)));
    this.addChild(new Line(palette.muted(this.options.hint)));
    this.addChild(new Line(""));
    this.addChild(this.valueLine);
    this.addChild(new Line(""));
    this.addChild(this.statusLine);
    this.addChild(new Line(palette.faint("Enter to save · Esc to cancel")));
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
    this.refreshValue();
  }

  private refreshValue(): void {
    const raw = this.input.getValue();
    const shown = this.options.mask ? "•".repeat(raw.length) : raw;
    const cursor = this._focused ? "\x1b[7m \x1b[27m" : "";
    this.valueLine.set(palette.accent("> ") + shown + cursor);
  }

  setStatus(message: string): void {
    this.statusLine.set(palette.muted(message));
    this.tui.requestRender();
  }

  setError(message: string): void {
    this.statusLine.set(palette.bad(message));
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    this.input.handleInput(data);
    this.refreshValue();
    this.tui.requestRender();
  }
}

class SettingsPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const health = this.store.get().health;
    const hasAny =
      (health?.chatGateways.length ?? 0) > 0 ||
      (health?.chatRoutes?.length ?? 0) > 0;
    const lines: string[] = ["", palette.label("SETTINGS · CHAT GATEWAYS"), ""];
    lines.push(
      hasAny
        ? palette.muted("Select a row and press Enter to edit it.")
        : palette.muted("No chat gateways are configured in config.yaml."),
    );
    lines.push("");
    return lines.map((line) => fit(line, width));
  }
}

export function createSettingsView(options: SettingsViewOptions): View {
  const { store, onEdit } = options;
  const root = new Container();
  const panel = new SettingsPanel(store);

  const rebuild = (ctx: ViewActivationContext): void => {
    root.clear();
    root.addChild(panel);

    const health = store.get().health;
    const actions: SettingsAction[] = [];
    const items: Array<{ value: string; label: string; description: string }> = [];

    for (const gateway of health?.chatGateways ?? []) {
      if (gateway.tokenEnv === undefined) continue;
      const dot = gateway.health.ok ? palette.good("●") : palette.bad("●");
      const connection = gateway.health.ok
        ? "connected"
        : (gateway.startupError ?? gateway.health.message ?? "not connected");
      items.push({
        value: String(actions.length),
        label: `${dot} token · ${gateway.id}`,
        description: `${gateway.secretConfigured ? "set" : "not set"} · ${connection}`,
      });
      actions.push({
        kind: "token",
        gatewayId: gateway.id,
        tokenEnv: gateway.tokenEnv,
        label: gateway.id,
      });
    }

    for (const route of health?.chatRoutes ?? []) {
      items.push({
        value: String(actions.length),
        label: `channel · ${route.id}`,
        description: route.conversationId ?? "#general (default)",
      });
      actions.push({
        kind: "channel",
        routeId: route.id,
        label: route.id,
        current: route.conversationId,
      });
    }

    if (actions.length === 0) {
      ctx.setFocus(null);
      return;
    }

    const list = new SelectList(
      items,
      Math.min(items.length, 8),
      selectListTheme,
    );
    list.onSelect = (item) => {
      const action = actions[Number(item.value)];
      if (action) onEdit(action);
    };
    list.onCancel = () => undefined;
    root.addChild(list);
    ctx.setFocus(list);
  };

  return {
    id: "settings",
    label: "Settings",
    hotkey: "s",
    description: "Configure chat gateway tokens and channels",
    root,
    onActivate: (ctx) => rebuild(ctx),
  };
}
