import type { CodeHostProvider, PullRequestRef } from '@agentroom/core';

export class GitHubCodeHostProvider implements CodeHostProvider {
  readonly id: string;
  readonly kind = 'github' as const;

  constructor(options: { id?: string; token?: string; owner?: string; repo?: string } = {}) {
    this.id = options.id ?? 'github';
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'GitHub adapter scaffold only. Implement REST/GraphQL client here.' };
  }

  async createPullRequest(input: { title: string; body: string; branch: string; base: string }): Promise<PullRequestRef> {
    return {
      id: `github-pr-placeholder-${input.branch}`,
      number: 0,
      title: input.title,
      url: '',
      branch: input.branch,
      status: 'open'
    };
  }

  async commentOnPullRequest(_prId: string, _body: string): Promise<void> {}
}
