// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderDrawio } from '@/render/drawio';
import { renderMermaid } from '@/render/mermaid';
import { claimPaymentModel } from '../fixtures/claim-payment';

describe('equivalent deterministic representations', () => {
  it('renders Claim-Payment keys, optionality and cardinality in Mermaid', () => {
    const actual = renderMermaid(claimPaymentModel);
    expect(actual).toContain('CLAIM ||--o{ PAYMENT : has');
    expect(actual).toContain('uuid claim_id PK "Stable claim identifier.; required"');
    expect(actual).toContain('date paid_at "Date funds were paid.; optional"');
  });

  it('renders importable draw.io XML with matching cells, edge and layout', () => {
    const actual = renderDrawio(claimPaymentModel);
    const document = new DOMParser().parseFromString(actual, 'application/xml');
    expect(document.querySelector('parsererror')).toBeNull();
    expect([...document.querySelectorAll('mxCell[vertex="1"]')].map(cell => cell.getAttribute('id'))).toEqual(['claim', 'payment']);
    const edge = document.querySelector('mxCell[edge="1"]');
    expect([edge?.getAttribute('source'), edge?.getAttribute('target'), edge?.getAttribute('value')]).toEqual([
      'claim', 'payment', 'has (one to zero or many)',
    ]);
    expect(document.querySelector('#payment mxGeometry')?.getAttribute('x')).toBe('520');
  });
});
