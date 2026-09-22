import type { CanonicalModel, GenerationResult, SourceArtifactInput } from '@/domain/model';

export const claimPaymentModel: CanonicalModel = {
  id: 'claim-payment',
  name: 'Claim Payment',
  businessDefinition: 'Tracks approved insurance claims and payments made against them.',
  entities: [
    {
      id: 'claim',
      name: 'Claim',
      businessDefinition: 'An assessed request for insurance compensation.',
      position: { x: 80, y: 100 },
      attributes: [
        { id: 'claim-id', name: 'claim_id', dataType: 'uuid', required: true, key: 'PK', references: null, businessDefinition: 'Stable claim identifier.' },
        { id: 'approved-amount', name: 'approved_amount', dataType: 'decimal', required: true, key: 'NONE', references: null, businessDefinition: 'Maximum amount approved for payment.' },
        { id: 'claim-currency', name: 'currency', dataType: 'char(3)', required: true, key: 'NONE', references: null, businessDefinition: 'ISO currency code for the approved amount.' },
      ],
    },
    {
      id: 'payment',
      name: 'Payment',
      businessDefinition: 'A payment requested or made against one claim.',
      position: { x: 520, y: 100 },
      attributes: [
        { id: 'payment-id', name: 'payment_id', dataType: 'uuid', required: true, key: 'PK', references: null, businessDefinition: 'Stable payment identifier.' },
        { id: 'payment-claim-id', name: 'claim_id', dataType: 'uuid', required: true, key: 'FK', references: { entityId: 'claim', attributeId: 'claim-id' }, businessDefinition: 'Claim paid by this payment.' },
        { id: 'payment-amount', name: 'amount', dataType: 'decimal', required: true, key: 'NONE', references: null, businessDefinition: 'Monetary payment amount.' },
        { id: 'payment-currency', name: 'currency', dataType: 'char(3)', required: true, key: 'NONE', references: null, businessDefinition: 'ISO currency code.' },
        { id: 'payment-status', name: 'status', dataType: 'varchar', required: true, key: 'NONE', references: null, businessDefinition: 'Requested, approved, paid or cancelled.' },
        { id: 'payment-method', name: 'method', dataType: 'varchar', required: true, key: 'NONE', references: null, businessDefinition: 'Transfer, cheque or another payment method.' },
        { id: 'requested-at', name: 'requested_at', dataType: 'date', required: true, key: 'NONE', references: null, businessDefinition: 'Date payment was requested.' },
        { id: 'approved-at', name: 'approved_at', dataType: 'date', required: false, key: 'NONE', references: null, businessDefinition: 'Date payment was approved.' },
        { id: 'paid-at', name: 'paid_at', dataType: 'date', required: false, key: 'NONE', references: null, businessDefinition: 'Date funds were paid.' },
        { id: 'external-reference', name: 'external_reference', dataType: 'varchar', required: false, key: 'NONE', references: null, businessDefinition: 'Reference from the payment platform.' },
      ],
    },
  ],
  relationships: [
    { id: 'claim-payments', name: 'has', fromEntityId: 'claim', toEntityId: 'payment', fromCardinality: 'one', toCardinality: 'zero-or-many' },
  ],
  rules: [
    { id: 'paid-within-approved', name: 'Total paid within approval', expression: 'sum(payment.amount where status = paid) <= claim.approved_amount', businessDefinition: 'Total paid cannot exceed the approved claim amount.', entityIds: ['claim', 'payment'] },
  ],
};

export const generatedClaimPayment: GenerationResult = {
  model: claimPaymentModel,
  assumptions: ['A claim uses one currency for approval and payments.'],
  warnings: [],
  clarificationQuestions: [],
};

export const claimSources: SourceArtifactInput[] = [
  { name: 'claim-payment.md', kind: 'markdown', content: '# Claim Payment\nOne claim can have many payments.' },
  { name: 'existing.ddl', kind: 'ddl', content: 'CREATE TABLE claim (claim_id UUID PRIMARY KEY);' },
];
