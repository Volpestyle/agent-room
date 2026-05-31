import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStore } from "./secretStore.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempSecretPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentroom-secrets-"));
  dirs.push(dir);
  return join(dir, "secrets.json");
}

describe("SecretStore", () => {
  it("persists a secret across instances, keyed by env-var name", () => {
    const path = tempSecretPath();
    const store = new SecretStore(path);
    expect(store.get("AGENTROOM_DISCORD_TOKEN")).toBeUndefined();

    store.set("AGENTROOM_DISCORD_TOKEN", "tok_abc123");
    expect(store.get("AGENTROOM_DISCORD_TOKEN")).toBe("tok_abc123");
    expect(store.has("AGENTROOM_DISCORD_TOKEN")).toBe(true);

    // A fresh instance reads the same persisted value (survives daemon restart).
    expect(new SecretStore(path).get("AGENTROOM_DISCORD_TOKEN")).toBe(
      "tok_abc123",
    );
  });

  it("writes the secret file with 0600 permissions", () => {
    const path = tempSecretPath();
    new SecretStore(path).set("AGENTROOM_DISCORD_TOKEN", "tok_abc123");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats an empty stored value as unset", () => {
    const path = tempSecretPath();
    const store = new SecretStore(path);
    store.set("AGENTROOM_DISCORD_TOKEN", "");
    expect(store.get("AGENTROOM_DISCORD_TOKEN")).toBeUndefined();
    expect(store.has("AGENTROOM_DISCORD_TOKEN")).toBe(false);
  });
});
