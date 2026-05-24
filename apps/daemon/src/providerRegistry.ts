import type { RuntimeProvider } from '@agentroom/core';
import { FakeRuntimeProvider } from '@agentroom/runtime-fake';
import { HerdrRuntimeProvider } from '@agentroom/runtime-herdr';
import { TmuxRuntimeProvider } from '@agentroom/runtime-tmux';

export class ProviderRegistry {
  private readonly runtimes = new Map<string, RuntimeProvider>();

  constructor() {
    this.registerRuntime(new FakeRuntimeProvider());
    this.registerRuntime(new HerdrRuntimeProvider({ ...(process.env.HERDR_SESSION ? { session: process.env.HERDR_SESSION } : {}) }));
    this.registerRuntime(new TmuxRuntimeProvider());
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
