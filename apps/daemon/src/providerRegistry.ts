import type { RuntimeProvider } from '@agentroom/core';
import { builtInRuntimeConfig, type AgentRoomConfig, type RuntimeConfig } from '@agentroom/config';
import { FakeRuntimeProvider } from '@agentroom/runtime-fake';
import { HerdrRuntimeProvider } from '@agentroom/runtime-herdr';
import { TmuxRuntimeProvider } from '@agentroom/runtime-tmux';

export class ProviderRegistry {
  private readonly runtimes = new Map<string, RuntimeProvider>();

  constructor(config?: AgentRoomConfig) {
    if (config) {
      for (const [id, runtime] of Object.entries(config.runtimes)) {
        this.registerRuntime(providerForConfig(id, runtime));
      }
    } else {
      this.registerRuntime(providerForConfig('fake-local', builtInRuntimeConfig('fake')));
      this.registerRuntime(providerForConfig('local-herdr', builtInRuntimeConfig('herdr')));
      this.registerRuntime(providerForConfig('local-tmux', builtInRuntimeConfig('tmux')));
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

function providerForConfig(id: string, runtime: RuntimeConfig): RuntimeProvider {
  switch (runtime.type) {
    case 'fake':
      return new FakeRuntimeProvider({ id });
    case 'herdr': {
      const session = process.env.HERDR_SESSION ?? runtime.session;
      return new HerdrRuntimeProvider({
        id,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(session !== undefined ? { session } : {})
      });
    }
    case 'tmux':
      return new TmuxRuntimeProvider({
        id,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(runtime.sessionPrefix !== undefined ? { sessionPrefix: runtime.sessionPrefix } : {})
      });
  }
}
