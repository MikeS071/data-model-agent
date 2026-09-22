import type { CanonicalModel, Cardinality } from '@/domain/model';

const marker: Record<Cardinality, string> = {
  one: '||',
  'zero-or-one': 'o|',
  'one-or-many': '|{',
  'zero-or-many': 'o{',
};
const identifier = (value: string) => value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
const type = (value: string) => value.replace(/[^A-Za-z0-9_()[\],]/gu, '_');
const label = (value: string) => value.replace(/["\n\r]/gu, "'");

export function renderMermaid(model: CanonicalModel): string {
  const lines = ['erDiagram'];
  for (const relationship of model.relationships) {
    const from = model.entities.find(entity => entity.id === relationship.fromEntityId)!;
    const to = model.entities.find(entity => entity.id === relationship.toEntityId)!;
    lines.push(`  ${identifier(from.name)} ${marker[relationship.fromCardinality]}--${marker[relationship.toCardinality]} ${identifier(to.name)} : ${identifier(relationship.name).toLowerCase()}`);
  }
  for (const entity of model.entities) {
    lines.push(`  ${identifier(entity.name)} {`);
    for (const attribute of entity.attributes) {
      const key = attribute.key === 'NONE' ? '' : ` ${attribute.key}`;
      const presence = attribute.required ? 'required' : 'optional';
      lines.push(`    ${type(attribute.dataType)} ${identifier(attribute.name).toLowerCase()}${key} "${label(attribute.businessDefinition)}; ${presence}"`);
    }
    lines.push('  }');
  }
  return `${lines.join('\n')}\n`;
}
