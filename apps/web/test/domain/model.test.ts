import { describe, expect, it } from 'vitest';
import { parseGenerationResult, validateCanonicalModel } from '@/domain/model';
import { claimPaymentModel, generatedClaimPayment } from '../fixtures/claim-payment';

describe('canonical model boundary', () => {
  it('preserves the literal Claim-Payment semantics', () => {
    const actual = validateCanonicalModel(structuredClone(claimPaymentModel));
    expect(actual).toEqual(claimPaymentModel);
    expect(actual.entities[1].attributes.map(attribute => attribute.name)).toEqual([
      'payment_id', 'claim_id', 'amount', 'currency', 'status', 'method',
      'requested_at', 'approved_at', 'paid_at', 'external_reference',
    ]);
    expect(actual.relationships[0]).toEqual({
      id: 'claim-payments', name: 'has', fromEntityId: 'claim', toEntityId: 'payment',
      fromCardinality: 'one', toCardinality: 'zero-or-many',
    });
    expect(actual.rules[0].expression).toBe('sum(payment.amount where status = paid) <= claim.approved_amount');
  });

  it('refuses relationships and foreign keys that invent missing domain objects', () => {
    const relationship = structuredClone(claimPaymentModel);
    relationship.relationships[0].toEntityId = 'invented';
    expect(() => validateCanonicalModel(relationship)).toThrow('relationship-target-missing');

    const reference = structuredClone(claimPaymentModel);
    reference.entities[1].attributes[1].references = { entityId: 'claim', attributeId: 'invented' };
    expect(() => validateCanonicalModel(reference)).toThrow('foreign-key-attribute-missing');
  });

  it('keeps ambiguity explicit without a fabricated relationship', () => {
    const ambiguous = structuredClone(generatedClaimPayment);
    ambiguous.model.relationships = [];
    ambiguous.assumptions = ['Payment may be associated with a claim.'];
    ambiguous.warnings = ['Relationship cardinality was not supplied.'];
    ambiguous.clarificationQuestions = ['How many claims can one payment settle?'];
    const actual = parseGenerationResult(ambiguous);
    expect(actual.model.relationships).toEqual([]);
    expect(actual.warnings).toEqual(['Relationship cardinality was not supplied.']);
    expect(actual.clarificationQuestions).toEqual(['How many claims can one payment settle?']);
  });
});
