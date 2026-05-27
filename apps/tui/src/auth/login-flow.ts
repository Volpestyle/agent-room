import { exec } from "node:child_process";
import { platform } from "node:os";
import type {
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth";

export interface LoginFlowCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onDeviceCode?: (info: OAuthDeviceCodeInfo) => void;
  onProgress?: (message: string) => void;
  /** Resolve with the pasted authorization code / redirect URL. Throw to cancel. */
  readManualCode: () => Promise<string>;
  /** Optional generic prompt fallback (e.g. for providers that ask follow-up questions). */
  readPrompt?: (prompt: OAuthPrompt) => Promise<string>;
  /** Optional select prompt; without it, the first option is picked. */
  readSelect?: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
}

/**
 * Build the OAuthLoginCallbacks the provider's login() expects, bridged to
 * TUI-friendly hooks. Also opens the URL in the system browser when it can.
 */
export function buildLoginCallbacks(
  callbacks: LoginFlowCallbacks,
): OAuthLoginCallbacks {
  return {
    onAuth: (info) => {
      tryOpenBrowser(info.url);
      callbacks.onAuth(info);
    },
    onDeviceCode: (info) => {
      callbacks.onDeviceCode?.(info);
      tryOpenBrowser(info.verificationUri);
    },
    onPrompt: async (prompt) => {
      if (callbacks.readPrompt) return callbacks.readPrompt(prompt);
      return callbacks.readManualCode();
    },
    onManualCodeInput: () => callbacks.readManualCode(),
    onSelect: async (prompt) => {
      if (callbacks.readSelect) return callbacks.readSelect(prompt);
      return prompt.options[0]?.id;
    },
    ...(callbacks.onProgress !== undefined
      ? { onProgress: callbacks.onProgress }
      : {}),
  };
}

function tryOpenBrowser(url: string): void {
  const cmd =
    platform() === "darwin"
      ? `open ${shellQuote(url)}`
      : platform() === "win32"
        ? `start "" ${shellQuote(url)}`
        : `xdg-open ${shellQuote(url)}`;
  exec(cmd, () => {
    // best-effort; the URL is also shown in the overlay so the user can copy it manually.
  });
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
