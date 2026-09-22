'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanonicalModel, GenerationResult, SourceArtifact, SourceArtifactInput, SourceKind } from '@/domain/model';

interface VersionSummary { id: string; versionNumber: number; createdAt: string }
interface ProjectSummary { id: string; title: string; updatedAt: string; versionCount: number; hasDraft: boolean }
interface Project {
  id: string; title: string; requirements: string; createdAt: string; updatedAt: string;
  sources: SourceArtifact[]; draft: GenerationResult | null; versions: VersionSummary[];
}

const emptyDraft = { title: '', requirements: '', sources: [] as SourceArtifactInput[] };
const sourceKind = (name: string): SourceKind | null => {
  const extension = name.toLowerCase().split('.').pop();
  return extension === 'md' ? 'markdown' : extension === 'sql' ? 'sql' : extension === 'ddl' ? 'ddl'
    : extension === 'json' ? 'json' : extension === 'txt' ? 'text' : null;
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'request-failed');
  return body as T;
}

function MermaidPreview({ source }: { source: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let active = true;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      const result = await mermaid.render(`model-${crypto.randomUUID()}`, source);
      if (active) setSvg(result.svg);
    }).catch(() => { if (active) setSvg(''); });
    return () => { active = false; };
  }, [source]);
  return svg ? <div className="mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre className="code-preview">{source}</pre>;
}

function DiagramPreview({ model }: { model: CanonicalModel }) {
  const width = Math.max(900, ...model.entities.map(entity => entity.position.x + 340));
  const height = Math.max(420, ...model.entities.map(entity => entity.position.y + 260));
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  return <div className="diagram-scroll"><svg className="diagram-preview" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="draw.io model preview">
    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" /></marker></defs>
    {model.relationships.map(relationship => {
      const from = byId.get(relationship.fromEntityId), to = byId.get(relationship.toEntityId);
      if (!from || !to) return null;
      const x1 = from.position.x + 280, y1 = from.position.y + 58, x2 = to.position.x, y2 = to.position.y + 58;
      return <g key={relationship.id}><path className="relationship-line" d={`M${x1} ${y1} C${x1 + 60} ${y1},${x2 - 60} ${y2},${x2} ${y2}`} markerEnd="url(#arrow)" />
        <text className="relationship-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10}>{relationship.name}</text></g>;
    })}
    {model.entities.map(entity => <g key={entity.id} transform={`translate(${entity.position.x} ${entity.position.y})`}>
      <rect className="entity-card" width="280" height={Math.max(118, 60 + entity.attributes.length * 21)} rx="16" />
      <text className="entity-title" x="18" y="30">{entity.name}</text>
      {entity.attributes.map((attribute, index) => <text className="entity-field" key={attribute.id} x="18" y={58 + index * 21}>
        {attribute.key !== 'NONE' ? `${attribute.key} ` : ''}{attribute.name}: {attribute.dataType}{attribute.required ? '' : '?'}
      </text>)}
    </g>)}
  </svg></div>;
}

export function ModelWorkbench() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [intake, setIntake] = useState(emptyDraft);
  const [clarification, setClarification] = useState('');
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<'mermaid' | 'drawio'>('mermaid');
  const editRevision = useRef(0);

  const refreshProjects = async () => setProjects(await requestJson<ProjectSummary[]>('/api/projects'));
  useEffect(() => { void refreshProjects().catch(error => setError(message(error))); }, []);

  useEffect(() => {
    if (!project?.draft || !dirty) return;
    const revision = editRevision.current;
    setStatus('Saving draft…');
    const timer = window.setTimeout(() => {
      void requestJson<GenerationResult>(`/api/projects/${project.id}/draft`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.draft),
      }).then(() => {
        if (editRevision.current === revision) { setDirty(false); setStatus('Draft saved'); }
      }).catch(error => { setError(message(error)); setStatus('Save failed'); });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [dirty, project]);

  const mermaid = useMemo(() => {
    if (!project?.draft) return '';
    const marker = { one: '||', 'zero-or-one': 'o|', 'one-or-many': '|{', 'zero-or-many': 'o{' } as const;
    const id = (value: string) => value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
    const lines = ['erDiagram'];
    for (const relationship of project.draft.model.relationships) {
      const from = project.draft.model.entities.find(entity => entity.id === relationship.fromEntityId)!;
      const to = project.draft.model.entities.find(entity => entity.id === relationship.toEntityId)!;
      lines.push(`  ${id(from.name)} ${marker[relationship.fromCardinality]}--${marker[relationship.toCardinality]} ${id(to.name)} : ${id(relationship.name).toLowerCase()}`);
    }
    for (const entity of project.draft.model.entities) {
      lines.push(`  ${id(entity.name)} {`);
      for (const attribute of entity.attributes) lines.push(`    ${attribute.dataType.replace(/\s/gu, '_')} ${id(attribute.name).toLowerCase()}${attribute.key === 'NONE' ? '' : ` ${attribute.key}`}`);
      lines.push('  }');
    }
    return lines.join('\n');
  }, [project?.draft]);

  const loadProject = async (id: string) => {
    setError(''); setStatus('Loading…');
    try { setProject(await requestJson<Project>(`/api/projects/${id}`)); setStatus('Ready'); }
    catch (error) { setError(message(error)); setStatus('Load failed'); }
  };

  const filesSelected = async (files: FileList | null) => {
    if (!files) return;
    setError('');
    try {
      const sources = await Promise.all([...files].map(async file => {
        const kind = sourceKind(file.name);
        if (!kind) throw new Error(`Unsupported file: ${file.name}`);
        return { name: file.name, kind, content: await file.text() };
      }));
      setIntake(current => ({ ...current, sources }));
    } catch (error) { setError(message(error)); }
  };

  const generate = async () => {
    setError(''); setStatus('Preparing draft…');
    try {
      let target = project;
      if (!target) target = await requestJson<Project>('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intake),
      });
      setStatus('Generating with OpenAI…');
      target = await requestJson<Project>(`/api/projects/${target.id}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clarification: clarification || null }),
      });
      setProject(target); setClarification(''); setDirty(false); setStatus('Draft ready');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Generation stopped'); await refreshProjects().catch(() => undefined); }
  };

  const updateModel = (change: (model: CanonicalModel) => void) => {
    if (!project?.draft) return;
    const next = structuredClone(project);
    change(next.draft!.model);
    editRevision.current += 1;
    setProject(next); setDirty(true);
  };

  const saveVersion = async () => {
    if (!project?.draft) return;
    setError(''); setStatus('Saving version…');
    try {
      if (dirty) await requestJson(`/api/projects/${project.id}/draft`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.draft),
      });
      await requestJson(`/api/projects/${project.id}/versions`, { method: 'POST' });
      setProject(await requestJson<Project>(`/api/projects/${project.id}`));
      setDirty(false); setStatus('Version saved'); await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Version not saved'); }
  };

  const continueVersion = async (versionNumber: number) => {
    if (!project) return;
    setError(''); setStatus(`Opening version ${versionNumber}…`);
    try {
      await requestJson(`/api/projects/${project.id}/versions/${versionNumber}`, { method: 'POST' });
      setProject(await requestJson<Project>(`/api/projects/${project.id}`));
      setStatus(`Version ${versionNumber} opened as working draft`);
    } catch (error) { setError(message(error)); }
  };

  const latest = project?.versions[0]?.versionNumber ?? null;
  const foreignKeyTargets = project?.draft?.model.entities.flatMap(entity => entity.attributes
    .filter(attribute => attribute.key === 'PK')
    .map(attribute => ({ value: `${entity.id}:${attribute.id}`, label: `${entity.name}.${attribute.name}` }))) ?? [];
  return <main className="app-shell">
    <header className="hero">
      <div><span className="eyebrow">Insurance data design workspace</span><h1>Turn complex requirements into models people can trust.</h1>
        <p>Develop one canonical model, clarify uncertainty, then export consistent Mermaid and draw.io representations.</p></div>
      <div className="pilot-badge"><span className="signal" />Local single-user pilot</div>
    </header>

    <div className="workspace">
      <aside className="sidebar panel">
        <div className="section-heading"><div><span className="step">01</span><h2>Models</h2></div><button className="text-button" onClick={() => { setProject(null); setIntake(emptyDraft); setError(''); }}>New</button></div>
        <div className="project-list">{projects.length ? projects.map(item => <button className={`project-item ${project?.id === item.id ? 'active' : ''}`} key={item.id} onClick={() => void loadProject(item.id)}>
          <strong>{item.title}</strong><span>{item.versionCount} version{item.versionCount === 1 ? '' : 's'} · {item.hasDraft ? 'draft' : 'empty'}</span>
        </button>) : <p className="empty-copy">No saved models yet</p>}</div>
        <div className="privacy-note"><strong>Before you generate</strong><p>Generate sends the supplied material to OpenAI through the server. Credentials stay server-side.</p></div>
      </aside>

      <section className="main-column">
        {!project ? <section className="panel intake-card">
          <div className="section-heading"><div><span className="step">02</span><h2>Start a model</h2></div><span className="status-dot">{status}</span></div>
          <label>Model name<input aria-label="Model name" value={intake.title} onChange={event => setIntake({ ...intake, title: event.target.value })} placeholder="e.g. Claim Payment" /></label>
          <label>Requirements<textarea aria-label="Requirements" value={intake.requirements} onChange={event => setIntake({ ...intake, requirements: event.target.value })} placeholder="Describe the entities, relationships, rules and questions…" rows={8} /></label>
          <label className="file-drop">Source files<input aria-label="Source files" type="file" multiple accept=".md,.txt,.sql,.ddl,.json" onChange={event => void filesSelected(event.target.files)} />
            <span>Drop or choose Markdown, text, SQL, DDL or JSON</span></label>
          {intake.sources.length > 0 && <ul className="source-list">{intake.sources.map(source => <li key={source.name}>{source.name}<span>{source.kind}</span></li>)}</ul>}
          <button className="primary-button" disabled={!intake.title.trim() || !intake.requirements.trim()} onClick={() => void generate()}>Generate draft <span>→</span></button>
        </section> : project.draft ? <>
          <section className="panel model-header">
            <div><span className="eyebrow">Working draft</span><h2>{project.draft.model.name} model</h2><p>{project.draft.model.businessDefinition}</p></div>
            <div className="header-actions"><span className="status-dot">{status}</span><button className="secondary-button" onClick={() => void generate()}>Regenerate</button><button className="primary-button compact" onClick={() => void saveVersion()}>Save version</button></div>
          </section>

          {(project.draft.assumptions.length > 0 || project.draft.warnings.length > 0 || project.draft.clarificationQuestions.length > 0) && <section className="review-grid">
            <div className="panel review-card"><span className="card-label">Assumptions</span>{project.draft.assumptions.length ? <ul>{project.draft.assumptions.map(item => <li key={item}>{item}</li>)}</ul> : <p>None</p>}</div>
            <div className="panel review-card warning"><span className="card-label">Warnings</span>{project.draft.warnings.length ? <ul>{project.draft.warnings.map(item => <li key={item}>{item}</li>)}</ul> : <p>No warnings</p>}</div>
            <div className="panel review-card question"><span className="card-label">Next clarification</span><p>{project.draft.clarificationQuestions[0] ?? 'No open questions'}</p>
              {project.draft.clarificationQuestions[0] && <><input aria-label="Clarification answer" value={clarification} onChange={event => setClarification(event.target.value)} placeholder="Answer this question" /><button className="text-button" onClick={() => void generate()}>Update draft →</button></>}</div>
          </section>}

          <section className="panel editor-card">
            <div className="section-heading"><div><span className="step">03</span><h2>Structured editor</h2></div><span>{project.draft.model.entities.length} entities · {project.draft.model.relationships.length} relationships</span></div>
            <div className="model-fields">
              <label>Model name<input aria-label="Canonical model name" value={project.draft.model.name} onChange={event => updateModel(model => { model.name = event.target.value; })} /></label>
              <label>Business definition<textarea aria-label="Canonical model business definition" value={project.draft.model.businessDefinition} onChange={event => updateModel(model => { model.businessDefinition = event.target.value; })} rows={2} /></label>
            </div>
            <div className="entity-grid">{project.draft.model.entities.map((entity, entityIndex) => <article className="entity-editor" key={entity.id}>
              <div className="entity-editor-head"><span>Entity {String(entityIndex + 1).padStart(2, '0')}</span><button className="icon-button" disabled={project.draft!.model.entities.length === 1} aria-label={`Remove ${entity.name}`} onClick={() => updateModel(model => {
                const removed = model.entities[entityIndex];
                model.entities.splice(entityIndex, 1);
                model.relationships = model.relationships.filter(item => item.fromEntityId !== removed.id && item.toEntityId !== removed.id);
                model.rules.forEach(rule => { rule.entityIds = rule.entityIds.filter(id => id !== removed.id); });
                model.entities.forEach(item => item.attributes.forEach(attribute => {
                  if (attribute.references?.entityId === removed.id) { attribute.key = 'NONE'; attribute.references = null; }
                }));
              })}>×</button></div>
              <label>Name<input aria-label={`Entity name ${entity.name}`} value={entity.name} onChange={event => updateModel(model => { model.entities[entityIndex].name = event.target.value; })} /></label>
              <label>Business definition<textarea aria-label={`${entity.name} business definition`} value={entity.businessDefinition} onChange={event => updateModel(model => { model.entities[entityIndex].businessDefinition = event.target.value; })} rows={2} /></label>
              <div className="position-fields">
                <label>Layout X<input aria-label={`Entity position X ${entity.name}`} type="number" value={entity.position.x} onChange={event => updateModel(model => { model.entities[entityIndex].position.x = Number(event.target.value); })} /></label>
                <label>Layout Y<input aria-label={`Entity position Y ${entity.name}`} type="number" value={entity.position.y} onChange={event => updateModel(model => { model.entities[entityIndex].position.y = Number(event.target.value); })} /></label>
              </div>
              <div className="attribute-table"><div className="attribute-row attribute-labels"><span>Attribute</span><span>Type</span><span>Key</span><span>Reference</span><span>Required</span><span /></div>
                {entity.attributes.map((attribute, attributeIndex) => <div className="attribute-item" key={attribute.id}><div className="attribute-row">
                  <input aria-label={`${entity.name} attribute ${attributeIndex + 1}`} value={attribute.name} onChange={event => updateModel(model => { model.entities[entityIndex].attributes[attributeIndex].name = event.target.value; })} />
                  <input aria-label={`${attribute.name} type`} value={attribute.dataType} onChange={event => updateModel(model => { model.entities[entityIndex].attributes[attributeIndex].dataType = event.target.value; })} />
                  <select aria-label={`${attribute.name} key`} value={attribute.key} onChange={event => updateModel(model => {
                    const item = model.entities[entityIndex].attributes[attributeIndex];
                    const key = event.target.value as typeof item.key;
                    if (key === 'FK') {
                      const target = model.entities.flatMap(candidateEntity => candidateEntity.attributes
                        .filter(candidate => candidate.key === 'PK' && candidate.id !== item.id)
                        .map(candidate => ({ entityId: candidateEntity.id, attributeId: candidate.id })))[0];
                      if (!target) return;
                      item.key = key; item.references = target;
                    } else { item.key = key; item.references = null; }
                  })}><option>NONE</option><option>PK</option><option disabled={foreignKeyTargets.every(target => target.value === `${entity.id}:${attribute.id}`)}>FK</option></select>
                  {attribute.key === 'FK' ? <select aria-label={`${attribute.name} reference`} value={`${attribute.references?.entityId}:${attribute.references?.attributeId}`} onChange={event => updateModel(model => {
                    const [entityId, attributeId] = event.target.value.split(':');
                    model.entities[entityIndex].attributes[attributeIndex].references = { entityId, attributeId };
                  })}>{foreignKeyTargets.filter(target => target.value !== `${entity.id}:${attribute.id}`).map(target => <option value={target.value} key={target.value}>{target.label}</option>)}</select> : <span className="no-reference">—</span>}
                  <input aria-label={`${attribute.name} required`} type="checkbox" checked={attribute.required} onChange={event => updateModel(model => { model.entities[entityIndex].attributes[attributeIndex].required = event.target.checked; })} />
                  <button className="icon-button" aria-label={`Remove attribute ${attribute.name}`} onClick={() => updateModel(model => {
                    const removed = model.entities[entityIndex].attributes[attributeIndex];
                    model.entities[entityIndex].attributes.splice(attributeIndex, 1);
                    model.entities.forEach(item => item.attributes.forEach(candidate => {
                      if (candidate.references?.attributeId === removed.id) { candidate.key = 'NONE'; candidate.references = null; }
                    }));
                  })}>×</button>
                </div><input className="attribute-definition" aria-label={`${entity.name} ${attribute.name} definition`} value={attribute.businessDefinition} onChange={event => updateModel(model => { model.entities[entityIndex].attributes[attributeIndex].businessDefinition = event.target.value; })} placeholder="Business definition" /></div>)}
              </div>
              <button className="text-button" onClick={() => updateModel(model => { const attributes = model.entities[entityIndex].attributes; attributes.push({ id: crypto.randomUUID(), name: `new_attribute_${attributes.length + 1}`, dataType: 'varchar', required: false, key: 'NONE', references: null, businessDefinition: 'Define this attribute.' }); })}>+ Add attribute</button>
            </article>)}</div>
            <button className="secondary-button add-entity" onClick={() => updateModel(model => { const ordinal = model.entities.length + 1; model.entities.push({ id: crypto.randomUUID(), name: `New Entity ${ordinal}`, businessDefinition: 'Define this entity.', position: { x: 80 + model.entities.length * 360, y: 360 }, attributes: [{ id: crypto.randomUUID(), name: 'id', dataType: 'uuid', required: true, key: 'PK', references: null, businessDefinition: 'Stable identifier.' }] }); })}>+ Add entity</button>

            <div className="relationship-editor"><h3>Relationships</h3>{project.draft.model.relationships.map((relationship, index) => <div className="relationship-row" key={relationship.id}>
              <input aria-label={`Relationship ${index + 1} name`} value={relationship.name} onChange={event => updateModel(model => { model.relationships[index].name = event.target.value; })} />
              <select aria-label={`Relationship ${index + 1} source`} value={relationship.fromEntityId} onChange={event => updateModel(model => { model.relationships[index].fromEntityId = event.target.value; })}>{project.draft!.model.entities.map(entity => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select>
              <select aria-label={`Relationship ${index + 1} source cardinality`} value={relationship.fromCardinality} onChange={event => updateModel(model => { model.relationships[index].fromCardinality = event.target.value as typeof relationship.fromCardinality; })}><option value="one">one</option><option value="zero-or-one">zero or one</option><option value="one-or-many">one or many</option><option value="zero-or-many">zero or many</option></select>
              <span>to</span>
              <select aria-label={`Relationship ${index + 1} target`} value={relationship.toEntityId} onChange={event => updateModel(model => { model.relationships[index].toEntityId = event.target.value; })}>{project.draft!.model.entities.map(entity => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select>
              <select aria-label={`Relationship ${index + 1} target cardinality`} value={relationship.toCardinality} onChange={event => updateModel(model => { model.relationships[index].toCardinality = event.target.value as typeof relationship.toCardinality; })}><option value="one">one</option><option value="zero-or-one">zero or one</option><option value="one-or-many">one or many</option><option value="zero-or-many">zero or many</option></select>
              <button className="icon-button" aria-label={`Remove relationship ${relationship.name}`} onClick={() => updateModel(model => { model.relationships.splice(index, 1); })}>×</button>
            </div>)}<button className="text-button editor-add" onClick={() => updateModel(model => model.relationships.push({ id: crypto.randomUUID(), name: `relationship_${model.relationships.length + 1}`, fromEntityId: model.entities[0].id, toEntityId: model.entities[1]?.id ?? model.entities[0].id, fromCardinality: 'one', toCardinality: 'zero-or-many' }))}>+ Add relationship</button></div>

            <div className="rule-editor"><h3>Validation rules</h3>{project.draft.model.rules.map((rule, index) => <article className="rule-row" key={rule.id}>
              <div className="rule-heading"><strong>Rule {index + 1}</strong><button className="icon-button" aria-label={`Remove rule ${rule.name}`} onClick={() => updateModel(model => { model.rules.splice(index, 1); })}>×</button></div>
              <div className="rule-fields">
                <label>Name<input aria-label={`Rule ${index + 1} name`} value={rule.name} onChange={event => updateModel(model => { model.rules[index].name = event.target.value; })} /></label>
                <label>Expression<input aria-label={`Rule ${index + 1} expression`} value={rule.expression} onChange={event => updateModel(model => { model.rules[index].expression = event.target.value; })} /></label>
              </div>
              <label>Business definition<textarea aria-label={`Rule ${index + 1} business definition`} value={rule.businessDefinition} onChange={event => updateModel(model => { model.rules[index].businessDefinition = event.target.value; })} rows={2} /></label>
              <fieldset><legend>Applies to</legend>{project.draft!.model.entities.map(item => <label className="entity-choice" key={item.id}><input type="checkbox" checked={rule.entityIds.includes(item.id)} onChange={event => updateModel(model => {
                const ids = model.rules[index].entityIds;
                model.rules[index].entityIds = event.target.checked ? [...new Set([...ids, item.id])] : ids.filter(id => id !== item.id);
              })} />{item.name}</label>)}</fieldset>
            </article>)}<button className="text-button editor-add" onClick={() => updateModel(model => model.rules.push({ id: crypto.randomUUID(), name: `Rule ${model.rules.length + 1}`, expression: 'Define expression', businessDefinition: 'Define this validation rule.', entityIds: [model.entities[0].id] }))}>+ Add validation rule</button></div>
          </section>

          <section className="panel preview-card">
            <div className="section-heading"><div><span className="step">04</span><h2>Representations</h2></div><div className="segmented"><button className={preview === 'mermaid' ? 'active' : ''} onClick={() => setPreview('mermaid')}>Mermaid</button><button className={preview === 'drawio' ? 'active' : ''} onClick={() => setPreview('drawio')}>draw.io</button></div></div>
            {preview === 'mermaid' ? <MermaidPreview source={mermaid} /> : <DiagramPreview model={project.draft.model} />}
            <details><summary>Canonical JSON · read only</summary><pre className="code-preview">{JSON.stringify(project.draft.model, null, 2)}</pre></details>
          </section>

          <section className="panel history-card"><div className="section-heading"><div><span className="step">05</span><h2>Version history</h2></div>{latest && <div className="download-actions"><a href={`/api/projects/${project.id}/downloads/mermaid?version=${latest}`}>Download Mermaid v{latest}</a><a href={`/api/projects/${project.id}/downloads/drawio?version=${latest}`}>Download draw.io v{latest}</a></div>}</div>
            {project.versions.length ? <ol className="version-list">{project.versions.map(version => <li key={version.id}><div><strong>Version {version.versionNumber}</strong><span>{new Date(version.createdAt).toLocaleString()}</span></div><button className="text-button" onClick={() => void continueVersion(version.versionNumber)}>Open as draft</button></li>)}</ol> : <p className="empty-copy">Save the reviewed draft to create version 1.</p>}
          </section>
        </> : <section className="panel intake-card"><div className="section-heading"><h2>{project.title}</h2><span className="status-dot">Saved without a draft</span></div><p>The previous generation did not complete. Your requirements and source files are preserved.</p><button className="primary-button" onClick={() => void generate()}>Retry generation <span>→</span></button></section>}
        {error && <div className="error-banner" role="alert"><strong>Action stopped</strong><span>{error}</span></div>}
      </section>
    </div>
  </main>;
}
