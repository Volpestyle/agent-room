import { describe, expect, it } from 'vitest';
import { semanticIdPart } from './ids.js';

describe('semanticIdPart', () => {
  it('normalizes a human title into a stable id-safe slug', () => {
    expect(semanticIdPart('Fix runtime doctor: provider health!')).toBe('fix_runtime_doctor_provider_health');
  });

  it('falls back to an empty slug when no semantic text remains', () => {
    expect(semanticIdPart('---')).toBe('');
  });
});
