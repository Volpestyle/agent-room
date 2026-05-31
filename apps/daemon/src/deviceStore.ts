import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DevicePlatform = "ios";
export type ApnsEnvironment = "sandbox" | "production";

export interface RegisteredDevice {
  token: string;
  platform: DevicePlatform;
  env: ApnsEnvironment;
  bundleId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRegistration {
  token: string;
  platform?: DevicePlatform;
  env?: ApnsEnvironment;
  bundleId?: string;
  label?: string;
}

/**
 * Small JSON-file-backed registry of push device tokens. Unlike the room event
 * log this is mutable upsert-by-token state, so it is stored as a rewritable
 * array document next to the event log rather than as append-only events.
 */
export class DeviceRegistry {
  private cache: RegisteredDevice[] | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async list(): Promise<RegisteredDevice[]> {
    return [...(await this.load())];
  }

  async upsert(input: DeviceRegistration): Promise<RegisteredDevice> {
    const token = input.token.trim();
    if (!token) throw new Error("device token is required");

    const devices = await this.load();
    const timestamp = this.now();
    const existing = devices.find((device) => device.token === token);
    const label = input.label ?? existing?.label;
    const device: RegisteredDevice = {
      token,
      platform: input.platform ?? existing?.platform ?? "ios",
      env: input.env ?? existing?.env ?? "sandbox",
      bundleId: input.bundleId ?? existing?.bundleId ?? "io.agentroom.ios",
      ...(label !== undefined ? { label } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    const next = devices.filter((entry) => entry.token !== token);
    next.push(device);
    await this.persist(next);
    return device;
  }

  async remove(token: string): Promise<boolean> {
    const devices = await this.load();
    const next = devices.filter((device) => device.token !== token.trim());
    if (next.length === devices.length) return false;
    await this.persist(next);
    return true;
  }

  private async load(): Promise<RegisteredDevice[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.cache = Array.isArray(parsed)
        ? (parsed.filter(isRegisteredDevice) as RegisteredDevice[])
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = [];
      } else {
        throw error;
      }
    }
    return this.cache;
  }

  private async persist(devices: RegisteredDevice[]): Promise<void> {
    this.cache = devices;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(devices, null, 2)}\n`, "utf8");
  }
}

function isRegisteredDevice(value: unknown): value is RegisteredDevice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string" && typeof record.bundleId === "string";
}
