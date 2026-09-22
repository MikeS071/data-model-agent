import type { CanonicalModel, Cardinality } from '@/domain/model';

const xml = (value: string | number) => String(value).replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const words: Record<Cardinality, string> = {
  one: 'one',
  'zero-or-one': 'zero or one',
  'one-or-many': 'one or many',
  'zero-or-many': 'zero or many',
};

export function renderDrawio(model: CanonicalModel): string {
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  for (const entity of model.entities) {
    const fields = entity.attributes.map(attribute => `${attribute.key === 'NONE' ? '' : `${attribute.key} `}${attribute.name}: ${attribute.dataType}${attribute.required ? '' : '?'}`);
    const value = `<b>${entity.name}</b><br>${fields.join('<br>')}`;
    const height = Math.max(100, 48 + entity.attributes.length * 22);
    cells.push(`<mxCell id="${xml(entity.id)}" value="${xml(value)}" style="rounded=1;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacing=10;" vertex="1" parent="1"><mxGeometry x="${xml(entity.position.x)}" y="${xml(entity.position.y)}" width="300" height="${height}" as="geometry"/></mxCell>`);
  }
  for (const relationship of model.relationships) {
    const value = `${relationship.name} (${words[relationship.fromCardinality]} to ${words[relationship.toCardinality]})`;
    cells.push(`<mxCell id="${xml(relationship.id)}" value="${xml(value)}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="${xml(relationship.fromEntityId)}" target="${xml(relationship.toEntityId)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><mxfile host="data-model-agent"><diagram id="${xml(model.id)}" name="${xml(model.name)}"><mxGraphModel><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}
