'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { CanonicalModel, GenerationResult, SourceArtifact, SourceArtifactInput, SourceKind } from '@/domain/model';

interface VersionSummary { id: string; versionNumber: number; createdAt: string }
interface ProjectSummary { id: string; title: string; updatedAt: string; versionCount: number; hasDraft: boolean }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
interface Project {
  id: string; title: string; requirements: string; createdAt: string; updatedAt: string;
  sources: SourceArtifact[]; draft: GenerationResult | null; versions: VersionSummary[]; messages: ChatMessage[];
}

const emptyDraft = { title: '', requirements: '', sources: [] as SourceArtifactInput[] };
const sourceKind = (name: string): SourceKind | null => {
  const extension = name.toLowerCase().split('.').pop();
  return extension === 'md' ? 'markdown' : extension === 'sql' ? 'sql' : extension === 'ddl' ? 'ddl'
    : extension === 'json' ? 'json' : extension === 'txt' ? 'text' : null;
};
const errorMessages: Record<string, string> = {
  'provider-timeout': 'OpenAI did not finish within the configured time. Your model is saved; retry or increase OPENAI_TIMEOUT_MS.',
  'provider-output-incomplete': 'OpenAI reached the configured output limit before completing the model. Increase OPENAI_MAX_OUTPUT_TOKENS and retry.',
  'provider-rate-limited': 'OpenAI is rate limiting requests. Your model is saved; wait briefly and retry.',
  'provider-not-configured': 'OpenAI is not configured. Add the server-side API key and model settings, then restart the server.',
  'provider-config-invalid': 'An OpenAI runtime setting is invalid. Check the server environment and restart the server.',
};
const message = (error: unknown) => error instanceof Error ? errorMessages[error.message] ?? error.message : 'Something went wrong.';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'request-failed');
  return body as T;
}

const projectIntake = (project: Project) => ({
  title: project.title,
  requirements: project.requirements,
  sources: project.sources.map(({ name, kind, content }) => ({ name, kind, content })),
});

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
  return <svg className="diagram-preview" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="draw.io model preview">
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
  </svg>;
}

type IconName = 'arrow' | 'chevron' | 'database' | 'minus' | 'plus' | 'reset' | 'shield' | 'trash';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
    minus: <path d="M5 12h14" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    reset: <><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v6h6" /></>,
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8.1 7 10 4.1-1.9 7-5.4 7-10V6l-7-3Z" />,
    trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m7 7 1 13h8l1-13" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const MODEL_VIEW_DEFAULT = { scale: 1, x: 0, y: 0 };
const clampScale = (value: number) => Math.min(2.5, Math.max(.5, Math.round(value * 1000) / 1000));

function InteractiveModelCanvas({ children }: { children: ReactNode }) {
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const [view, setView] = useState(MODEL_VIEW_DEFAULT);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      setView(current => {
        const scale = clampScale(current.scale * Math.exp(-event.deltaY * .0015));
        return {
          scale,
          x: anchorX - ((anchorX - current.x) / current.scale) * scale,
          y: anchorY - ((anchorY - current.y) / current.scale) * scale,
        };
      });
    };
    target.addEventListener('wheel', handleWheel, { passive: false });
    return () => target.removeEventListener('wheel', handleWheel);
  }, []);

  const zoomFromCentre = (factor: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    const anchorX = rect ? rect.width / 2 : 0;
    const anchorY = rect ? rect.height / 2 : 0;
    setView(current => {
      const scale = clampScale(current.scale * factor);
      return {
        scale,
        x: anchorX - ((anchorX - current.x) / current.scale) * scale,
        y: anchorY - ((anchorY - current.y) / current.scale) * scale,
      };
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setView(current => ({ ...current, x: start.x + event.clientX - start.startX, y: start.y + event.clientY - start.startY }));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDragging(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const pan = 40;
    if (event.key === 'ArrowLeft') setView(current => ({ ...current, x: current.x - pan }));
    else if (event.key === 'ArrowRight') setView(current => ({ ...current, x: current.x + pan }));
    else if (event.key === 'ArrowUp') setView(current => ({ ...current, y: current.y - pan }));
    else if (event.key === 'ArrowDown') setView(current => ({ ...current, y: current.y + pan }));
    else if (event.key === '+' || event.key === '=') zoomFromCentre(1.25);
    else if (event.key === '-') zoomFromCentre(.8);
    else if (event.key === '0') setView(MODEL_VIEW_DEFAULT);
    else return;
    event.preventDefault();
  };

  return <div className="model-canvas-block">
    <div className="canvas-toolbar">
      <span className="canvas-help" id="model-canvas-help">Scroll to zoom · drag to move · arrow keys to pan</span>
      <div className="canvas-controls">
        <button className="canvas-control" type="button" aria-label="Zoom out" onClick={() => zoomFromCentre(.8)}><Icon name="minus" /></button>
        <output aria-label="Zoom level" aria-live="polite">{Math.round(view.scale * 100)}%</output>
        <button className="canvas-control" type="button" aria-label="Zoom in" onClick={() => zoomFromCentre(1.25)}><Icon name="plus" /></button>
        <button className="canvas-reset" type="button" aria-label="Reset model view" onClick={() => setView(MODEL_VIEW_DEFAULT)}><Icon name="reset" />Reset</button>
      </div>
    </div>
    <div
      ref={canvas}
      className={`model-canvas${dragging ? ' dragging' : ''}`}
      role="group"
      aria-label="Interactive model canvas"
      aria-describedby="model-canvas-help"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="model-canvas-content"
        data-scale={view.scale}
        data-offset-x={view.x}
        data-offset-y={view.y}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >{children}</div>
    </div>
  </div>;
}

export function ModelWorkbench() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [intake, setIntake] = useState(emptyDraft);
  const [chatMessage, setChatMessage] = useState('');
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<'mermaid' | 'drawio'>('mermaid');
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(new Set());
  const editRevision = useRef(0);

  const refreshProjects = async () => setProjects(await requestJson<ProjectSummary[]>('/api/projects'));
  useEffect(() => { void refreshProjects().catch(error => setError(message(error))); }, []);
  useEffect(() => {
    if (!project?.draft) { setExpandedEntities(new Set()); return; }
    setExpandedEntities(current => {
      const valid = new Set(project.draft!.model.entities.map(entity => entity.id));
      const next = new Set([...current].filter(id => valid.has(id)));
      if (next.size === 0 && project.draft!.model.entities[0]) next.add(project.draft!.model.entities[0].id);
      return next;
    });
  }, [project?.id, project?.draft?.model.entities]);

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
    try {
      const loaded = await requestJson<Project>(`/api/projects/${id}`);
      setProject(loaded); setIntake(projectIntake(loaded)); setStatus('Ready');
    }
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
      setIntake(current => ({ ...current, sources: [...current.sources, ...sources] }));
    } catch (error) { setError(message(error)); }
  };

  const persistIntake = async () => {
    const target = project
      ? await requestJson<Project>(`/api/projects/${project.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intake),
      })
      : await requestJson<Project>('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intake),
      });
    setProject(target); setIntake(projectIntake(target));
    return target;
  };

  const saveIntake = async () => {
    setError(''); setStatus(project ? 'Saving changes…' : 'Saving model…');
    try {
      await persistIntake();
      setStatus(project ? 'Changes saved' : 'Model saved');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Save failed'); }
  };

  const generate = async () => {
    setError(''); setStatus('Preparing draft…');
    try {
      let target = project;
      if (!target?.draft) target = await persistIntake();
      setStatus('Generating with OpenAI…');
      target = await requestJson<Project>(`/api/projects/${target.id}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clarification: null }),
      });
      setProject(target); setDirty(false); setStatus('Draft ready');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Generation stopped'); await refreshProjects().catch(() => undefined); }
  };

  const removeProject = async () => {
    if (!project) return;
    const versionWarning = project.versions.length ? ` and its ${project.versions.length} saved version${project.versions.length === 1 ? '' : 's'}` : '';
    if (!window.confirm(`Delete “${project.title}”${versionWarning}? This cannot be undone.`)) return;
    setError(''); setStatus('Deleting model…');
    try {
      await requestJson<void>(`/api/projects/${project.id}`, { method: 'DELETE' });
      setProject(null); setIntake(emptyDraft); setDirty(false); setStatus('Model deleted');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Delete failed'); }
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

  const sendChatMessage = async () => {
    if (!project?.draft || !chatMessage.trim()) return;
    setError(''); setStatus('Updating model with assistant…');
    try {
      if (dirty) {
        await requestJson(`/api/projects/${project.id}/draft`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.draft),
        });
        setDirty(false);
      }
      const updated = await requestJson<Project>(`/api/projects/${project.id}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: chatMessage }),
      });
      setProject(updated); setChatMessage(''); setDirty(false); setStatus('Model updated from chat');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Chat update stopped'); }
  };

  const latest = project?.versions[0]?.versionNumber ?? null;
  const downloadStem = project?.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-|-$)/gu, '') || 'model';
  const foreignKeyTargets = project?.draft?.model.entities.flatMap(entity => entity.attributes
    .filter(attribute => attribute.key === 'PK')
    .map(attribute => ({ value: `${entity.id}:${attribute.id}`, label: `${entity.name}.${attribute.name}` }))) ?? [];
  // Background draft persistence must not lock the editor or prevent an explicit
  // version save; saveVersion writes the latest in-memory draft before snapshotting.
  const busy = status.endsWith('…') && status !== 'Saving draft…';
  return <main className="app-shell">
    <a className="skip-link" href="#work-area">Skip to work area</a>
    <header className="product-header">
      <div className="brand-lockup"><span className="brand-mark"><Icon name="database" /></span><span><strong>Model Foundry</strong><small>Insurance data design</small></span></div>
      <div className="pilot-badge"><span className="signal" />Local single-user pilot</div>
    </header>
    {!project && <header className="hero">
      <div><span className="eyebrow">Structured modelling workspace</span><h1>Turn complex requirements into models people can trust.</h1>
        <p>Develop one canonical model, surface uncertainty, and export consistent Mermaid and draw.io representations.</p></div>
    </header>}

    <div className="workspace">
      <aside className="sidebar panel" aria-label="Saved models">
        <div className="sidebar-heading"><div><span className="eyebrow">Workspace</span><h2>Models</h2></div><button className="secondary-button compact-button" onClick={() => { setProject(null); setIntake(emptyDraft); setError(''); setStatus('Ready'); }}>New model</button></div>
        <div className="project-list">{projects.length ? projects.map(item => <button className={`project-item ${project?.id === item.id ? 'active' : ''}`} aria-pressed={project?.id === item.id} key={item.id} onClick={() => void loadProject(item.id)}>
          <strong>{item.title}</strong><span>{item.versionCount} version{item.versionCount === 1 ? '' : 's'} · {item.hasDraft ? 'working draft' : 'empty'}</span>
        </button>) : <div className="empty-state"><Icon name="database" /><p>No saved models yet</p><span>Create your first model from requirements or source files.</span></div>}</div>
        <div className="privacy-note"><span className="privacy-icon"><Icon name="shield" /></span><div><strong>Before you generate</strong><p>Generate sends the supplied material to OpenAI through the server. Credentials stay server-side.</p></div></div>
      </aside>

      <section className="main-column" id="work-area" tabIndex={-1}>
        {error && <div className="error-banner" role="alert"><strong>Action stopped</strong><span>{error}</span></div>}
        {!project || !project.draft ? <section className="panel intake-card">
          <div className="section-heading"><div><span className="eyebrow">{project ? 'Model setup' : 'New model'}</span><h2>{project ? 'Refine the intake before generation' : 'Start with what you know'}</h2><p>Incomplete requirements are expected. Save the model without contacting OpenAI, then generate when it is ready.</p></div><span className="status-dot" aria-live="polite">{status}</span></div>
          <label>Model name<input aria-label="Model name" value={intake.title} onChange={event => setIntake({ ...intake, title: event.target.value })} placeholder="e.g. Claim Payment" /></label>
          <label>Requirements<textarea aria-label="Requirements" value={intake.requirements} onChange={event => setIntake({ ...intake, requirements: event.target.value })} placeholder="Describe the entities, relationships, rules and questions…" rows={8} /></label>
          <label className="file-drop"><span className="file-drop-title"><Icon name="plus" />Add source files</span><input aria-label="Source files" type="file" multiple accept=".md,.txt,.sql,.ddl,.json" onChange={event => void filesSelected(event.target.files)} />
            <span>Markdown, text, SQL, DDL or JSON · treated as inert text</span></label>
          {intake.sources.length > 0 && <ul className="source-list">{intake.sources.map((source, index) => <li key={`${source.name}-${index}`}><span className="source-name">{source.name}<small>{source.kind}</small></span><button className="icon-button destructive" aria-label={`Remove source ${source.name}`} onClick={() => setIntake(current => ({ ...current, sources: current.sources.filter((_, candidate) => candidate !== index) }))}><Icon name="trash" /></button></li>)}</ul>}
          <div className="intake-actions">
            <button className="secondary-button" disabled={busy || !intake.title.trim() || !intake.requirements.trim()} onClick={() => void saveIntake()}>{project ? 'Save changes' : 'Save model'}</button>
            <button className="primary-button" disabled={busy || !intake.title.trim() || !intake.requirements.trim()} onClick={() => void generate()}>Generate draft <Icon name="arrow" /></button>
            {project && <button className="danger-button" disabled={busy} onClick={() => void removeProject()}>Delete model</button>}
            <span>Save makes no provider call. Generate sends the current intake to OpenAI.</span>
          </div>
        </section> : <>
          <section className="panel model-header">
            <div><span className="eyebrow">Working draft</span><h1>{project.draft.model.name} model</h1><p>{project.draft.model.businessDefinition}</p></div>
            <div className="header-actions"><span className="status-dot" aria-live="polite">{status}</span><button className="secondary-button" disabled={busy} onClick={() => void generate()}>Regenerate</button><button className="primary-button" disabled={busy} onClick={() => void saveVersion()}>Save version</button><button className="danger-button" disabled={busy} onClick={() => void removeProject()}>Delete model</button></div>
          </section>

          <div className="model-collaboration-grid">
            <section className="panel preview-card" role="region" aria-label="Live model output">
              <div className="section-heading"><div><span className="eyebrow">Live output</span><h2>Model representations</h2><p>Both views are derived from the canonical model and update with each saved change.</p></div><div className="segmented" aria-label="Preview format"><button aria-pressed={preview === 'mermaid'} className={preview === 'mermaid' ? 'active' : ''} onClick={() => setPreview('mermaid')}>Mermaid</button><button aria-pressed={preview === 'drawio'} className={preview === 'drawio' ? 'active' : ''} onClick={() => setPreview('drawio')}>draw.io</button></div></div>
              <InteractiveModelCanvas key={preview}>
                {preview === 'mermaid' ? <MermaidPreview source={mermaid} /> : <DiagramPreview model={project.draft.model} />}
              </InteractiveModelCanvas>
              <details className="json-details"><summary>Canonical JSON <span>Read only</span></summary><pre className="code-preview">{JSON.stringify(project.draft.model, null, 2)}</pre></details>
            </section>

            <section className="panel assistant-card" role="region" aria-label="Model chat">
              <div className="section-heading"><div><span className="eyebrow">Model assistant</span><h2>Shape the model together</h2><p>Answer the next question or describe another change. Every successful reply updates the model.</p></div></div>
              <ol className="chat-transcript" aria-live="polite">
                {project.messages.map(item => <li className={`chat-message ${item.role}`} key={item.id}><span>{item.role === 'user' ? 'You' : 'Assistant'}</span><p>{item.content}</p></li>)}
                {project.draft.clarificationQuestions[0] ? <li className="chat-message assistant clarification-prompt"><span>Next clarification</span><p>{project.draft.clarificationQuestions[0]}</p></li>
                  : project.messages.length === 0 && <li className="chat-empty">No open questions. Try “Add recovery transactions and explain the relationship.”</li>}
              </ol>
              <label>{project.draft.clarificationQuestions[0] ? 'Answer or request a change' : 'Message'}<textarea aria-label="Message the model assistant" value={chatMessage} maxLength={4000} rows={3} onChange={event => setChatMessage(event.target.value)} placeholder={project.draft.clarificationQuestions[0] ? 'Answer the question or describe another change…' : 'Describe the change you want…'} /></label>
              <div className="chat-actions"><small>Your message, current model and source context are sent to OpenAI.</small><button className="primary-button" disabled={busy || !chatMessage.trim()} onClick={() => void sendChatMessage()}>Send message <Icon name="arrow" /></button></div>
            </section>
          </div>

          <section className="panel editor-card" role="region" aria-label="Structured model editor">
            <div className="section-heading"><div><span className="eyebrow">Canonical model</span><h2>Structured editor</h2><p>Edit the source of truth. Changes autosave to this working draft.</p></div><span className="count-badge">{project.draft.model.entities.length} entities · {project.draft.model.relationships.length} relationships</span></div>
            <div className="model-fields">
              <label>Model name<input aria-label="Canonical model name" value={project.draft.model.name} onChange={event => updateModel(model => { model.name = event.target.value; })} /></label>
              <label>Business definition<textarea aria-label="Canonical model business definition" value={project.draft.model.businessDefinition} onChange={event => updateModel(model => { model.businessDefinition = event.target.value; })} rows={2} /></label>
            </div>
            <div className="entity-grid">{project.draft.model.entities.map((entity, entityIndex) => <details className="entity-editor" open={expandedEntities.has(entity.id)} onToggle={event => {
              const open = event.currentTarget.open;
              setExpandedEntities(current => { const next = new Set(current); if (open) next.add(entity.id); else next.delete(entity.id); return next; });
            }} key={entity.id}>
              <summary><span className="entity-ordinal">Entity {String(entityIndex + 1).padStart(2, '0')}</span><span className="entity-summary"><strong>{entity.name}</strong><small>{entity.attributes.length} attributes</small></span><Icon name="chevron" /></summary>
              <div className="entity-body"><div className="entity-editor-head"><span>Entity details</span><button className="icon-button destructive" disabled={project.draft!.model.entities.length === 1} aria-label={`Remove ${entity.name}`} onClick={() => updateModel(model => {
                const removed = model.entities[entityIndex];
                model.entities.splice(entityIndex, 1);
                model.relationships = model.relationships.filter(item => item.fromEntityId !== removed.id && item.toEntityId !== removed.id);
                model.rules.forEach(rule => { rule.entityIds = rule.entityIds.filter(id => id !== removed.id); });
                model.entities.forEach(item => item.attributes.forEach(attribute => {
                  if (attribute.references?.entityId === removed.id) { attribute.key = 'NONE'; attribute.references = null; }
                }));
              })}><Icon name="trash" /></button></div>
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
                  <button className="icon-button destructive" aria-label={`Remove attribute ${attribute.name}`} onClick={() => updateModel(model => {
                    const removed = model.entities[entityIndex].attributes[attributeIndex];
                    model.entities[entityIndex].attributes.splice(attributeIndex, 1);
                    model.entities.forEach(item => item.attributes.forEach(candidate => {
                      if (candidate.references?.attributeId === removed.id) { candidate.key = 'NONE'; candidate.references = null; }
                    }));
                  })}><Icon name="trash" /></button>
                </div><input className="attribute-definition" aria-label={`${entity.name} ${attribute.name} definition`} value={attribute.businessDefinition} onChange={event => updateModel(model => { model.entities[entityIndex].attributes[attributeIndex].businessDefinition = event.target.value; })} placeholder="Business definition" /></div>)}
              </div>
              <button className="text-button" onClick={() => updateModel(model => { const attributes = model.entities[entityIndex].attributes; attributes.push({ id: crypto.randomUUID(), name: `new_attribute_${attributes.length + 1}`, dataType: 'varchar', required: false, key: 'NONE', references: null, businessDefinition: 'Define this attribute.' }); })}><Icon name="plus" />Add attribute</button>
            </div></details>)}</div>
            <button className="secondary-button add-entity" onClick={() => {
              const id = crypto.randomUUID();
              updateModel(model => { const ordinal = model.entities.length + 1; model.entities.push({ id, name: `New Entity ${ordinal}`, businessDefinition: 'Define this entity.', position: { x: 80 + model.entities.length * 360, y: 360 }, attributes: [{ id: crypto.randomUUID(), name: 'id', dataType: 'uuid', required: true, key: 'PK', references: null, businessDefinition: 'Stable identifier.' }] }); });
              setExpandedEntities(current => new Set(current).add(id));
            }}><Icon name="plus" />Add entity</button>

            <div className="relationship-editor"><div className="editor-group-heading"><div><h3>Relationships</h3><p>Connect entities and make cardinality explicit.</p></div></div><div className="relationship-labels"><span>Name</span><span>From</span><span>Cardinality</span><span /><span>To</span><span>Cardinality</span><span /></div>{project.draft.model.relationships.map((relationship, index) => <div className="relationship-row" key={relationship.id}>
              <input aria-label={`Relationship ${index + 1} name`} value={relationship.name} onChange={event => updateModel(model => { model.relationships[index].name = event.target.value; })} />
              <select aria-label={`Relationship ${index + 1} source`} value={relationship.fromEntityId} onChange={event => updateModel(model => { model.relationships[index].fromEntityId = event.target.value; })}>{project.draft!.model.entities.map(entity => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select>
              <select aria-label={`Relationship ${index + 1} source cardinality`} value={relationship.fromCardinality} onChange={event => updateModel(model => { model.relationships[index].fromCardinality = event.target.value as typeof relationship.fromCardinality; })}><option value="one">one</option><option value="zero-or-one">zero or one</option><option value="one-or-many">one or many</option><option value="zero-or-many">zero or many</option></select>
              <span>to</span>
              <select aria-label={`Relationship ${index + 1} target`} value={relationship.toEntityId} onChange={event => updateModel(model => { model.relationships[index].toEntityId = event.target.value; })}>{project.draft!.model.entities.map(entity => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select>
              <select aria-label={`Relationship ${index + 1} target cardinality`} value={relationship.toCardinality} onChange={event => updateModel(model => { model.relationships[index].toCardinality = event.target.value as typeof relationship.toCardinality; })}><option value="one">one</option><option value="zero-or-one">zero or one</option><option value="one-or-many">one or many</option><option value="zero-or-many">zero or many</option></select>
              <button className="icon-button destructive" aria-label={`Remove relationship ${relationship.name}`} onClick={() => updateModel(model => { model.relationships.splice(index, 1); })}><Icon name="trash" /></button>
            </div>)}<button className="text-button editor-add" onClick={() => updateModel(model => model.relationships.push({ id: crypto.randomUUID(), name: `relationship_${model.relationships.length + 1}`, fromEntityId: model.entities[0].id, toEntityId: model.entities[1]?.id ?? model.entities[0].id, fromCardinality: 'one', toCardinality: 'zero-or-many' }))}><Icon name="plus" />Add relationship</button></div>

            <div className="rule-editor"><div className="editor-group-heading"><div><h3>Validation rules</h3><p>Keep business constraints beside the model they protect.</p></div></div>{project.draft.model.rules.map((rule, index) => <article className="rule-row" key={rule.id}>
              <div className="rule-heading"><strong>Rule {String(index + 1).padStart(2, '0')}</strong><button className="icon-button destructive" aria-label={`Remove rule ${rule.name}`} onClick={() => updateModel(model => { model.rules.splice(index, 1); })}><Icon name="trash" /></button></div>
              <div className="rule-fields">
                <label>Name<input aria-label={`Rule ${index + 1} name`} value={rule.name} onChange={event => updateModel(model => { model.rules[index].name = event.target.value; })} /></label>
                <label>Expression<input aria-label={`Rule ${index + 1} expression`} value={rule.expression} onChange={event => updateModel(model => { model.rules[index].expression = event.target.value; })} /></label>
              </div>
              <label>Business definition<textarea aria-label={`Rule ${index + 1} business definition`} value={rule.businessDefinition} onChange={event => updateModel(model => { model.rules[index].businessDefinition = event.target.value; })} rows={2} /></label>
              <fieldset><legend>Applies to</legend>{project.draft!.model.entities.map(item => <label className="entity-choice" key={item.id}><input type="checkbox" checked={rule.entityIds.includes(item.id)} onChange={event => updateModel(model => {
                const ids = model.rules[index].entityIds;
                model.rules[index].entityIds = event.target.checked ? [...new Set([...ids, item.id])] : ids.filter(id => id !== item.id);
              })} />{item.name}</label>)}</fieldset>
            </article>)}<button className="text-button editor-add" onClick={() => updateModel(model => model.rules.push({ id: crypto.randomUUID(), name: `Rule ${model.rules.length + 1}`, expression: 'Define expression', businessDefinition: 'Define this validation rule.', entityIds: [model.entities[0].id] }))}><Icon name="plus" />Add validation rule</button></div>
          </section>

          <section className="panel history-card"><div className="section-heading"><div><span className="eyebrow">Review points</span><h2>Version history</h2><p>Freeze reviewed milestones and reopen an earlier version as a new working draft.</p></div></div>{latest && <div className="download-actions"><a download={`${downloadStem}-v${latest}.mmd`} href={`/api/projects/${project.id}/downloads/mermaid?version=${latest}`}>Download Mermaid v{latest}</a><a download={`${downloadStem}-v${latest}.drawio`} href={`/api/projects/${project.id}/downloads/drawio?version=${latest}`}>Download draw.io v{latest}</a></div>}
            {project.versions.length ? <ol className="version-list">{project.versions.map(version => <li key={version.id}><div><strong>Version {version.versionNumber}</strong><span>{new Date(version.createdAt).toLocaleString()}</span></div><button className="text-button" onClick={() => void continueVersion(version.versionNumber)}>Open as draft</button></li>)}</ol> : <p className="empty-copy">Save the reviewed draft to create version 1.</p>}
          </section>

          <section className="review-grid bottom-review" role="region" aria-label="Assumptions and warnings">
            <div className="panel review-card"><span className="card-label">Assumptions</span>{project.draft.assumptions.length ? <ul>{project.draft.assumptions.map(item => <li key={item}>{item}</li>)}</ul> : <p>No assumptions recorded.</p>}</div>
            <div className="panel review-card warning"><span className="card-label">Warnings</span>{project.draft.warnings.length ? <ul>{project.draft.warnings.map(item => <li key={item}>{item}</li>)}</ul> : <p>No warnings.</p>}</div>
          </section>
        </>}
      </section>
    </div>
  </main>;
}
