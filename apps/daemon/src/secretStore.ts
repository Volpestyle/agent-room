import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * File-backed store for daemon-side secrets (e.g. chat-gateway tokens), keyed by
 * the env-var name the secret satisfies. Values live in a 0600 JSON file so a
 * token set once (via the TUI Settings view) persists across restarts without
 * ever being written into config.yaml.
 *
 * A missing or unreadable file is treated as empty rather than fatal — a broken
 * secrets file must not stop the daemon from starting.
 */
export class SecretStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    try {
      if (!existsSync(this.path)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed === null || typeof parsed !== "object") return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  get(name: string): string | undefined {
    const value = this.read()[name];
    return value === undefined || value === "" ? undefined : value;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  set(name: string, value: string): void {
    const data = this.read();
    data[name] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(this.path, 0o600);
  }
}
