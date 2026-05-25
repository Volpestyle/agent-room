import { randomUUID } from 'node:crypto';

const MAX_SEMANTIC_ID_PART_LENGTH = 48;

export function createId(prefix: string, semanticSource?: string): string {
  const uuid = randomUUID();
  const semanticPart = semanticSource === undefined ? '' : semanticIdPart(semanticSource);
  return semanticPart.length > 0 ? `${prefix}_${semanticPart}_${uuid}` : `${prefix}_${uuid}`;
}

export function semanticIdPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, MAX_SEMANTIC_ID_PART_LENGTH)
    .replace(/_+$/g, '');
}

export function nowIso(): string {
  return new Date().toISOString();
}
