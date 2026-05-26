import * as SecureStore from "expo-secure-store";

export type ConnectionMode = "local" | "tailnet" | "custom";

export interface ConnectionSettings {
  mode: ConnectionMode;
  baseUrl: string;
  token: string;
}

const modeKey = "agentroom.connection.mode";
const baseUrlKey = "agentroom.connection.baseUrl";
const tokenKey = "agentroom.connection.token";

export const defaultConnection: ConnectionSettings = {
  mode: "local",
  baseUrl: "http://127.0.0.1:4317",
  token: "",
};

export async function loadConnectionSettings(): Promise<ConnectionSettings> {
  const [mode, baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(modeKey),
    SecureStore.getItemAsync(baseUrlKey),
    SecureStore.getItemAsync(tokenKey),
  ]);

  return {
    mode: isConnectionMode(mode) ? mode : defaultConnection.mode,
    baseUrl: baseUrl ?? defaultConnection.baseUrl,
    token: token ?? defaultConnection.token,
  };
}

export async function saveConnectionSettings(
  settings: ConnectionSettings,
): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(modeKey, settings.mode),
    SecureStore.setItemAsync(baseUrlKey, normalizeBaseUrl(settings.baseUrl)),
    settings.token
      ? SecureStore.setItemAsync(tokenKey, settings.token)
      : SecureStore.deleteItemAsync(tokenKey),
  ]);
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Use an http or https AgentRoom URL.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function isLikelyTailnetUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith(".ts.net") || isTailscaleIpv4(host);
  } catch {
    return false;
  }
}

function isConnectionMode(value: string | null): value is ConnectionMode {
  return value === "local" || value === "tailnet" || value === "custom";
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [first, second] = parts;
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}
