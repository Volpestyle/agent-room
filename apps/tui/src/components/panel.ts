import type { Component } from "@earendil-works/pi-tui";

/**
 * Base class for dashboard panels that always re-render from a store.
 * Provides the required `invalidate` no-op so the panel implements `Component`.
 */
export abstract class PanelBase implements Component {
  abstract render(width: number): string[];
  invalidate(): void {
    // panels do not cache between renders; nothing to invalidate.
  }
}
