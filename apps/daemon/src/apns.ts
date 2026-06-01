import {
  createPrivateKey,
  type KeyObject,
  sign as cryptoSign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect as http2Connect } from "node:http2";
import type { ApnsEnvironment, RegisteredDevice } from "./deviceStore.js";

export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  defaultEnv: ApnsEnvironment;
}

export interface ApnsSendResult {
  token: string;
  ok: boolean;
  status: number;
  reason?: string;
}

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/**
 * Read APNs provider credentials from the environment. Secrets (the .p8 key
 * path + key id) never live in config.yaml. Returns undefined when push is not
 * configured so callers can degrade gracefully.
 */
export function apnsConfigFromEnv(): ApnsConfig | undefined {
  const keyPath = process.env.AGENTROOM_APNS_KEY_PATH?.trim();
  const keyId = process.env.AGENTROOM_APNS_KEY_ID?.trim();
  const teamId = process.env.AGENTROOM_APNS_TEAM_ID?.trim() || "8YW4D4C6CW";
  const bundleId =
    process.env.AGENTROOM_APNS_BUNDLE_ID?.trim() || "io.agentroom.ios";
  const defaultEnv: ApnsEnvironment =
    process.env.AGENTROOM_APNS_ENV?.trim() === "production"
      ? "production"
      : "sandbox";

  if (!keyPath || !keyId || !teamId) return undefined;
  return { keyPath, keyId, teamId, bundleId, defaultEnv };
}

export interface ConnectPushPayload {
  roomId: string;
  baseUrl?: string;
  mode?: "tailnet" | "custom";
  silent?: boolean;
  grant?: string;
  grantsByDeviceToken?: Record<string, string>;
}

export class ApnsClient {
  private key: KeyObject | null = null;
  private jwt: { value: string; issuedAt: number } | null = null;

  constructor(private readonly config: ApnsConfig) {}

  /**
   * Send a "connect" event to every registered device. Each device is reached
   * on the APNs host matching the environment it registered with (a dev build
   * is provisioned for sandbox, TestFlight/App Store for production).
   */
  async sendConnect(
    devices: RegisteredDevice[],
    payload: ConnectPushPayload,
  ): Promise<ApnsSendResult[]> {
    if (devices.length === 0) return [];
    const jwt = await this.providerToken();

    const byEnv = new Map<ApnsEnvironment, RegisteredDevice[]>();
    for (const device of devices) {
      const env = device.env ?? this.config.defaultEnv;
      const bucket = byEnv.get(env) ?? [];
      bucket.push(device);
      byEnv.set(env, bucket);
    }

    const results: ApnsSendResult[] = [];
    for (const [env, bucket] of byEnv) {
      results.push(...(await this.sendBatch(env, bucket, jwt, payload)));
    }
    return results;
  }

  private async sendBatch(
    env: ApnsEnvironment,
    devices: RegisteredDevice[],
    jwt: string,
    payload: ConnectPushPayload,
  ): Promise<ApnsSendResult[]> {
    const client = http2Connect(APNS_HOSTS[env]);
    const results: ApnsSendResult[] = [];
    try {
      await Promise.all(
        devices.map(
          (device) =>
            new Promise<void>((resolve) => {
              const body = JSON.stringify(
                buildConnectNotification(
                  withDeviceGrant(
                    payload,
                    payload.grantsByDeviceToken?.[device.token] ??
                      payload.grant,
                  ),
                ),
              );
              const req = client.request({
                ":method": "POST",
                ":path": `/3/device/${device.token}`,
                authorization: `bearer ${jwt}`,
                "apns-topic": this.config.bundleId,
                "apns-push-type":
                  payload.silent === true ? "background" : "alert",
                "apns-priority": payload.silent === true ? "5" : "10",
                "content-type": "application/json",
              });

              let status = 0;
              const chunks: Buffer[] = [];
              req.on("response", (headers) => {
                status = Number(headers[":status"] ?? 0);
              });
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("error", (error) => {
                results.push({
                  token: device.token,
                  ok: false,
                  status,
                  reason: error.message,
                });
                resolve();
              });
              req.on("end", () => {
                const ok = status >= 200 && status < 300;
                const reason = ok ? undefined : apnsReason(chunks);
                results.push({
                  token: device.token,
                  ok,
                  status,
                  ...(reason !== undefined ? { reason } : {}),
                });
                resolve();
              });
              req.end(body);
            }),
        ),
      );
    } finally {
      client.close();
    }
    return results;
  }

  private async providerToken(): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    // APNs rejects regenerating the provider token more than once per ~20min
    // (TooManyProviderTokenUpdates) and accepts a token for up to 1h. Reuse for 40min.
    if (this.jwt && nowSeconds - this.jwt.issuedAt < 40 * 60) {
      return this.jwt.value;
    }
    const key = await this.loadKey();
    const header = base64url(
      JSON.stringify({ alg: "ES256", kid: this.config.keyId }),
    );
    const claims = base64url(
      JSON.stringify({ iss: this.config.teamId, iat: nowSeconds }),
    );
    const signingInput = `${header}.${claims}`;
    // JWS ES256 requires the raw R||S signature (ieee-p1363), not crypto's
    // default DER encoding.
    const signature = cryptoSign("sha256", Buffer.from(signingInput), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    const value = `${signingInput}.${base64url(signature)}`;
    this.jwt = { value, issuedAt: nowSeconds };
    return value;
  }

  private async loadKey(): Promise<KeyObject> {
    if (this.key) return this.key;
    const pem = await readFile(this.config.keyPath, "utf8");
    this.key = createPrivateKey(pem);
    return this.key;
  }
}

function withDeviceGrant(
  payload: ConnectPushPayload,
  grant: string | undefined,
): ConnectPushPayload {
  if (grant === undefined) return payload;
  return { ...payload, grant };
}

function buildConnectNotification(payload: ConnectPushPayload): unknown {
  const agentroom: Record<string, unknown> = {
    action: "connect",
    roomId: payload.roomId,
    ...(payload.baseUrl !== undefined ? { baseUrl: payload.baseUrl } : {}),
    ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
    ...(payload.grant !== undefined ? { grant: payload.grant } : {}),
  };

  if (payload.silent === true) {
    return { aps: { "content-available": 1 }, agentroom };
  }

  return {
    aps: {
      alert: {
        title: "AgentRoom",
        body: "Tap to connect this room to your phone.",
      },
      sound: "default",
      "content-available": 1,
    },
    agentroom,
  };
}

function apnsReason(chunks: Buffer[]): string | undefined {
  if (chunks.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      reason?: string;
    };
    return parsed.reason;
  } catch {
    return undefined;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}
