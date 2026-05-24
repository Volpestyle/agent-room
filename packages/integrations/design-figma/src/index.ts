import type { DesignProvider, Ref } from '@agentroom/core';

export class FigmaDesignProvider implements DesignProvider {
  readonly id: string;
  readonly kind = 'figma' as const;

  constructor(options: { id?: string; token?: string } = {}) {
    this.id = options.id ?? 'figma';
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'Figma adapter scaffold only. Implement REST client here.' };
  }

  async resolveRef(ref: Ref): Promise<{ title: string; summary?: string; url?: string; metadata?: Record<string, unknown> }> {
    return {
      title: ref.label ?? ref.id,
      ...(ref.url !== undefined ? { url: ref.url } : {}),
      ...(ref.metadata !== undefined ? { metadata: ref.metadata } : {})
    };
  }
}
