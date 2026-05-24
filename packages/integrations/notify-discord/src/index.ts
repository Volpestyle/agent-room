import type { NotificationProvider } from '@agentroom/core';

export class DiscordNotificationProvider implements NotificationProvider {
  readonly id: string;
  readonly kind = 'discord' as const;

  constructor(options: { id?: string; botToken?: string; channelId?: string } = {}) {
    this.id = options.id ?? 'discord';
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'Discord adapter scaffold only. Implement Gateway/REST client here.' };
  }

  async notify(input: Parameters<NotificationProvider['notify']>[0]): Promise<void> {
    console.log(`[discord-placeholder] ${input.title}: ${input.body}`);
  }
}
