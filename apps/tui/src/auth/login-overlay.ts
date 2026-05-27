import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { palette } from "../theme.js";

export interface LoginOverlayResult {
  /** Resolves with the pasted code; rejects if the user cancels. */
  manualCode: Promise<string>;
  setUrl(url: string, instructions?: string): void;
  setStatus(message: string): void;
  setError(message: string): void;
  close(): void;
}

class TitleLine implements Component {
  constructor(public text: string) {}
  render(width: number): string[] {
    return [fit(this.text, width)];
  }
  invalidate(): void {}
}

class BodyLines implements Component {
  constructor(public lines: string[] = []) {}
  set(lines: string[]): void {
    this.lines = lines;
  }
  render(width: number): string[] {
    return this.lines.map((line) => fit(line, width));
  }
  invalidate(): void {}
}

class LoginOverlay extends Container implements Focusable {
  private titleLine: TitleLine;
  private headerLines: BodyLines;
  private urlLines: BodyLines;
  private statusLines: BodyLines;
  private input: Input;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    provider: string,
    private readonly onSubmit: (code: string) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.titleLine = new TitleLine(palette.label(`/login ${provider}`));
    this.headerLines = new BodyLines([
      palette.muted("Starting OAuth flow…"),
    ]);
    this.urlLines = new BodyLines([]);
    this.statusLines = new BodyLines([]);
    this.input = new Input();
    this.input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      this.onSubmit(trimmed);
    };
    this.input.onEscape = () => this.onCancel();

    this.addChild(this.titleLine);
    this.addChild(this.headerLines);
    this.addChild(new BodyLines([""]));
    this.addChild(this.urlLines);
    this.addChild(new BodyLines([""]));
    this.addChild(
      new TitleLine(palette.muted("Paste the code from the redirect URL:")),
    );
    this.addChild(this.input);
    this.addChild(new BodyLines([""]));
    this.addChild(this.statusLines);
    this.addChild(
      new TitleLine(palette.faint("Enter to submit · Esc to cancel")),
    );
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  setUrl(url: string, instructions?: string): void {
    const lines = [palette.accent(url)];
    if (instructions) lines.push(palette.muted(instructions));
    this.urlLines.set(lines);
    this.headerLines.set([
      palette.muted("Browser opened. Complete login there, or paste the code below."),
    ]);
    this.tui.requestRender();
  }

  setStatus(message: string): void {
    this.statusLines.set([palette.muted(message)]);
    this.tui.requestRender();
  }

  setError(message: string): void {
    this.statusLines.set([palette.bad(message)]);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    this.input.handleInput(data);
  }
}

export function showLoginOverlay(
  tui: TUI,
  provider: string,
): LoginOverlayResult {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const manualCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const overlay = new LoginOverlay(
    tui,
    provider,
    (code) => resolveCode(code),
    () => rejectCode(new Error("Login cancelled.")),
  );
  const handle = tui.showOverlay(overlay, {
    width: "80%",
    minWidth: 60,
    maxHeight: "70%",
    anchor: "center",
  });

  return {
    manualCode,
    setUrl: (url, instructions) => overlay.setUrl(url, instructions),
    setStatus: (msg) => overlay.setStatus(msg),
    setError: (msg) => overlay.setError(msg),
    close: () => handle.hide(),
  };
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}
