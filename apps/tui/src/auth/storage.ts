/**
 * Minimal credential storage for the AgentRoom TUI.
 * Stores OAuth tokens and plain API keys in ~/.agentroom/auth.json
 * (mode 0600). Single-process; no file locking.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getOAuthApiKey,
  getOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderId,
} from "@earendil-works/pi-ai/oauth";
import { getEnvApiKey } from "@earendil-works/pi-ai";

export type ApiKeyCredential = { type: "api_key"; key: string };
export type OAuthCredential = { type: "oauth" } & OAuthCredentials;
export type AuthCredential = ApiKeyCredential | OAuthCredential;
export type AuthData = Record<string, AuthCredential>;

export interface AuthStatus {
  configured: boolean;
  source: "stored-oauth" | "stored-api-key" | "environment" | "none";
  label?: string;
}

const DEFAULT_PATH = join(
  process.env.AGENTROOM_HOME ?? join(homedir(), ".agentroom"),
  "auth.json",
);

export class AuthStorage {
  private data: AuthData = {};

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.reload();
  }

  static default(): AuthStorage {
    return new AuthStorage();
  }

  get authPath(): string {
    return this.path;
  }

  reload(): void {
    try {
      if (!existsSync(this.path)) {
        this.data = {};
        return;
      }
      const raw = readFileSync(this.path, "utf-8");
      this.data = raw.trim() ? (JSON.parse(raw) as AuthData) : {};
    } catch {
      this.data = {};
    }
  }

  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best-effort on non-posix
    }
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  get(provider: string): AuthCredential | undefined {
    return this.data[provider];
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.persist();
  }

  remove(provider: string): void {
    if (!(provider in this.data)) return;
    delete this.data[provider];
    this.persist();
  }

  status(provider: string): AuthStatus {
    const stored = this.data[provider];
    if (stored?.type === "oauth") {
      const label = stored.accountId ? String(stored.accountId) : undefined;
      return {
        configured: true,
        source: "stored-oauth",
        ...(label !== undefined ? { label } : {}),
      };
    }
    if (stored?.type === "api_key") {
      return { configured: true, source: "stored-api-key" };
    }
    const env = getEnvApiKey(provider);
    if (env) return { configured: true, source: "environment" };
    return { configured: false, source: "none" };
  }

  /**
   * Run an OAuth login for `providerId` and persist the resulting credentials.
   */
  async login(
    providerId: OAuthProviderId,
    callbacks: OAuthLoginCallbacks,
  ): Promise<void> {
    const provider = getOAuthProvider(providerId);
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  /**
   * Resolve a usable API key for `providerId` — refreshes OAuth tokens
   * via pi-ai when expired and persists the new credentials.
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const cred = this.data[providerId];
    if (cred?.type === "api_key") return cred.key;
    if (cred?.type === "oauth") {
      const provider = getOAuthProvider(providerId);
      if (!provider) return undefined;
      const allOAuth: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(this.data)) {
        if (value.type === "oauth") allOAuth[key] = value;
      }
      const refreshed = await getOAuthApiKey(providerId, allOAuth);
      if (!refreshed) return provider.getApiKey(cred);
      // persist refreshed credentials so a later cold start uses the
      // freshly-minted refresh token rather than the expired one.
      this.set(providerId, { type: "oauth", ...refreshed.newCredentials });
      return refreshed.apiKey;
    }
    return getEnvApiKey(providerId);
  }
}
