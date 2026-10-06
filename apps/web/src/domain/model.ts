export type Cardinality = 'one' | 'zero-or-one' | 'one-or-many' | 'zero-or-many';
export type AttributeKey = 'PK' | 'FK' | 'NONE';
export type SourceKind = 'text' | 'markdown' | 'sql' | 'ddl' | 'json' | 'csv';
export type CsvHeaderMode = 'first-row' | 'generated';
export type CsvInferredType = 'empty' | 'boolean' | 'integer' | 'decimal' | 'date' | 'datetime' | 'string';

export interface CsvColumnProfile {
  index: number;
  name: string;
  inferredType: CsvInferredType;
  nullable: boolean;
  nullRatio: number;
  uniqueRatio: number;
  minLength: number;
  maxLength: number;
  formats: string[];
  sensitive: boolean;
  sensitivity: string[];
}

export interface CsvSampleRow {
  rowIndex: number;
  values: string[];
}

export interface CsvAnalysis {
  analysisVersion: number;
  contentDigest: string;
  maskingGenerationId: string;
  intakeSessionId: string | null;
  inferredHeaderMode: CsvHeaderMode;
  headerMode: CsvHeaderMode;
  headers: string[];
  rowCount: number;
  columnCount: number;
  columns: CsvColumnProfile[];
  sampleRows: CsvSampleRow[];
  additionalSensitiveColumns: number[];
  confirmed: boolean;
  confirmedAt: string | null;
}

export interface SourceArtifactInput {
  clientId?: string;
  name: string;
  kind: SourceKind;
  content: string;
  csvAnalysis?: CsvAnalysis | null;
}

export interface SourceArtifact extends SourceArtifactInput {
  id: string;
  ordinal: number;
}

export interface ProviderSourceInput {
  name: string;
  kind: SourceKind;
  content: string;
}

export interface ModelAttribute {
  id: string;
  name: string;
  dataType: string;
  required: boolean;
  key: AttributeKey;
  references: { entityId: string; attributeId: string } | null;
  businessDefinition: string;
}

export interface ModelEntity {
  id: string;
  name: string;
  businessDefinition: string;
  position: { x: number; y: number };
  attributes: ModelAttribute[];
}

export interface ModelRelationship {
  id: string;
  name: string;
  fromEntityId: string;
  toEntityId: string;
  fromCardinality: Cardinality;
  toCardinality: Cardinality;
}

export interface ModelRule {
  id: string;
  name: string;
  expression: string;
  businessDefinition: string;
  entityIds: string[];
}

export interface CanonicalModel {
  id: string;
  name: string;
  businessDefinition: string;
  entities: ModelEntity[];
  relationships: ModelRelationship[];
  rules: ModelRule[];
}

export interface GenerationResult {
  model: CanonicalModel;
  assumptions: string[];
  warnings: string[];
  clarificationQuestions: string[];
}

export interface RevisionResult extends GenerationResult {
  assistantMessage: string;
}

const cardinalities = new Set<Cardinality>(['one', 'zero-or-one', 'one-or-many', 'zero-or-many']);
const keys = new Set<AttributeKey>(['PK', 'FK', 'NONE']);
const record = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};
const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value;
};
const array = (value: unknown, code: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};
const textList = (value: unknown, code: string): string[] => {
  const values = array(value, code).map(item => text(item, code));
  if (new Set(values).size !== values.length) throw new Error(code);
  return values;
};
const unique = (values: string[], code: string) => {
  if (new Set(values).size !== values.length) throw new Error(code);
};

export function validateCanonicalModel(value: unknown): CanonicalModel {
  const model = record(value, 'model-invalid');
  const entities = array(model.entities, 'entities-invalid').map((candidate): ModelEntity => {
    const entity = record(candidate, 'entity-invalid');
    const position = record(entity.position, 'entity-position-invalid');
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('entity-position-invalid');
    const attributes = array(entity.attributes, 'attributes-invalid').map((candidateAttribute): ModelAttribute => {
      const attribute = record(candidateAttribute, 'attribute-invalid');
      if (typeof attribute.required !== 'boolean' || !keys.has(attribute.key as AttributeKey)) throw new Error('attribute-invalid');
      let references: ModelAttribute['references'] = null;
      if (attribute.references !== null) {
        const reference = record(attribute.references, 'foreign-key-reference-invalid');
        references = { entityId: text(reference.entityId, 'foreign-key-reference-invalid'), attributeId: text(reference.attributeId, 'foreign-key-reference-invalid') };
      }
      if ((attribute.key === 'FK') !== (references !== null)) throw new Error('foreign-key-reference-invalid');
      return {
        id: text(attribute.id, 'attribute-invalid'), name: text(attribute.name, 'attribute-invalid'),
        dataType: text(attribute.dataType, 'attribute-invalid'), required: attribute.required,
        key: attribute.key as AttributeKey, references,
        businessDefinition: text(attribute.businessDefinition, 'attribute-invalid'),
      };
    });
    unique(attributes.map(attribute => attribute.id), 'attribute-id-duplicate');
    unique(attributes.map(attribute => attribute.name), 'attribute-name-duplicate');
    return {
      id: text(entity.id, 'entity-invalid'), name: text(entity.name, 'entity-invalid'),
      businessDefinition: text(entity.businessDefinition, 'entity-invalid'),
      position: { x: position.x as number, y: position.y as number }, attributes,
    };
  });
  if (entities.length === 0) throw new Error('entities-empty');
  unique(entities.map(entity => entity.id), 'entity-id-duplicate');
  unique(entities.map(entity => entity.name), 'entity-name-duplicate');
  const entityById = new Map(entities.map(entity => [entity.id, entity]));
  for (const entity of entities) for (const attribute of entity.attributes) if (attribute.references) {
    const target = entityById.get(attribute.references.entityId);
    if (!target) throw new Error('foreign-key-entity-missing');
    if (!target.attributes.some(candidate => candidate.id === attribute.references?.attributeId)) throw new Error('foreign-key-attribute-missing');
  }

  const relationships = array(model.relationships, 'relationships-invalid').map((candidate): ModelRelationship => {
    const relationship = record(candidate, 'relationship-invalid');
    const fromCardinality = relationship.fromCardinality as Cardinality;
    const toCardinality = relationship.toCardinality as Cardinality;
    if (!cardinalities.has(fromCardinality) || !cardinalities.has(toCardinality)) throw new Error('relationship-cardinality-invalid');
    const result = {
      id: text(relationship.id, 'relationship-invalid'), name: text(relationship.name, 'relationship-invalid'),
      fromEntityId: text(relationship.fromEntityId, 'relationship-invalid'), toEntityId: text(relationship.toEntityId, 'relationship-invalid'),
      fromCardinality, toCardinality,
    };
    if (!entityById.has(result.fromEntityId)) throw new Error('relationship-source-missing');
    if (!entityById.has(result.toEntityId)) throw new Error('relationship-target-missing');
    return result;
  });
  unique(relationships.map(relationship => relationship.id), 'relationship-id-duplicate');

  const rules = array(model.rules, 'rules-invalid').map((candidate): ModelRule => {
    const rule = record(candidate, 'rule-invalid');
    const entityIds = textList(rule.entityIds, 'rule-entity-invalid');
    if (entityIds.some(id => !entityById.has(id))) throw new Error('rule-entity-missing');
    return {
      id: text(rule.id, 'rule-invalid'), name: text(rule.name, 'rule-invalid'),
      expression: text(rule.expression, 'rule-invalid'), businessDefinition: text(rule.businessDefinition, 'rule-invalid'), entityIds,
    };
  });
  unique(rules.map(rule => rule.id), 'rule-id-duplicate');

  return {
    id: text(model.id, 'model-invalid'), name: text(model.name, 'model-invalid'),
    businessDefinition: text(model.businessDefinition, 'model-invalid'), entities, relationships, rules,
  };
}

export function parseGenerationResult(value: unknown): GenerationResult {
  const result = record(value, 'generation-result-invalid');
  const model = structuredClone(result.model);
  let unresolvedForeignKeys = 0;
  if (model && typeof model === 'object' && !Array.isArray(model) && Array.isArray((model as Record<string, unknown>).entities)) {
    for (const candidateEntity of (model as { entities: unknown[] }).entities) {
      if (!candidateEntity || typeof candidateEntity !== 'object' || Array.isArray(candidateEntity)) continue;
      const attributes = (candidateEntity as Record<string, unknown>).attributes;
      if (!Array.isArray(attributes)) continue;
      for (const candidateAttribute of attributes) {
        if (!candidateAttribute || typeof candidateAttribute !== 'object' || Array.isArray(candidateAttribute)) continue;
        const attribute = candidateAttribute as Record<string, unknown>;
        if (attribute.key === 'FK' && attribute.references === null) {
          attribute.key = 'NONE';
          unresolvedForeignKeys += 1;
        }
      }
    }
  }
  const warnings = Array.isArray(result.warnings) ? [...result.warnings] : result.warnings;
  const downgradeWarning = 'Unresolved foreign-key markers without a reference target were retained as ordinary attributes.';
  if (unresolvedForeignKeys > 0 && Array.isArray(warnings) && !warnings.includes(downgradeWarning)) {
    warnings.push(downgradeWarning);
  }
  return {
    model: validateCanonicalModel(model),
    assumptions: textList(result.assumptions, 'generation-assumptions-invalid'),
    warnings: textList(warnings, 'generation-warnings-invalid'),
    clarificationQuestions: textList(result.clarificationQuestions, 'generation-questions-invalid'),
  };
}

export function parseRevisionResult(value: unknown): RevisionResult {
  const result = record(value, 'revision-result-invalid');
  return { ...parseGenerationResult(result), assistantMessage: text(result.assistantMessage, 'revision-message-invalid') };
}
