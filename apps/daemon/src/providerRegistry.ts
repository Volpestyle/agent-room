import type { RuntimeProvider } from "@agentroom/core";
import {
  builtInRuntimeConfig,
  type AgentRoomConfig,
  type RuntimeConfig,
} from "@agentroom/config";
import { FakeRuntimeProvider } from "@agentroom/runtime-fake";
import { HerdrRuntimeProvider } from "@agentroom/runtime-herdr";
import { TmuxRuntimeProvider } from "@agentroom/runtime-tmux";
import { ZellijRuntimeProvider } from "@agentroom/runtime-zellij";

export class ProviderRegistry {
  private readonly runtimes = new Map<string, RuntimeProvider>();

  constructor(config?: AgentRoomConfig) {
    if (config) {
      for (const [id, runtime] of Object.entries(config.runtimes)) {
        this.registerRuntime(providerForConfig(id, runtime));
      }
    } else {
      this.registerRuntime(
        providerForConfig("fake", builtInRuntimeConfig("fake")),
      );
      this.registerRuntime(
        providerForConfig("herdr", builtInRuntimeConfig("herdr")),
      );
      this.registerRuntime(
        providerForConfig("tmux", builtInRuntimeConfig("tmux")),
      );
      this.registerRuntime(
        providerForConfig("zellij", builtInRuntimeConfig("zellij")),
      );
    }
  }

  registerRuntime(provider: RuntimeProvider): void {
    this.runtimes.set(provider.id, provider);
  }

  listRuntimes(): RuntimeProvider[] {
    return [...this.runtimes.values()];
  }

  runtime(id: string): RuntimeProvider {
    const provider = this.runtimes.get(id);
    if (!provider) throw new Error(`Unknown runtime provider: ${id}`);
    return provider;
  }
}

function providerForConfig(
  id: string,
  runtime: RuntimeConfig,
): RuntimeProvider {
  switch (runtime.type) {
    case "fake":
      return new FakeRuntimeProvider({ id });
    case "herdr": {
      const session = runtime.session ?? process.env.HERDR_SESSION;
      return new HerdrRuntimeProvider({
        id,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(runtime.layout !== undefined ? { layout: runtime.layout } : {}),
      });
    }
    case "tmux":
      return new TmuxRuntimeProvider({
        id,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(runtime.sessionPrefix !== undefined
          ? { sessionPrefix: runtime.sessionPrefix }
          : {}),
      });
    case "zellij":
      return new ZellijRuntimeProvider({
        id,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(runtime.session !== undefined ? { session: runtime.session } : {}),
      });
  }
}
