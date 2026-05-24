import type { NotificationProvider } from '@agentroom/core';

export class TelegramNotificationProvider implements NotificationProvider {
  readonly id: string;
  readonly kind = 'telegram' as const;

  constructor(options: { id?: string; botToken?: string; chatId?: string } = {}) {
    this.id = options.id ?? 'telegram';
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'Telegram adapter scaffold only. Implement Bot API client here.' };
  }

  async notify(input: Parameters<NotificationProvider['notify']>[0]): Promise<void> {
    console.log(`[telegram-placeholder] ${input.title}: ${input.body}`);
  }
}
