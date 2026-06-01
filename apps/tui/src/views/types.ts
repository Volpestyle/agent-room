import type { Component } from "@earendil-works/pi-tui";

export interface ViewActivationContext {
  setFocus(component: Component | null): void;
}

export interface View {
  id: string;
  label: string;
  hotkey: string; // single character pressed alone (no modifier) to switch
  description?: string;
  scrollback?: boolean;
  root: Component;
  onActivate?(ctx: ViewActivationContext): void;
  onDeactivate?(): void;
}
