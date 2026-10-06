'use client';

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  CanonicalModel,
  CsvAnalysis,
  CsvHeaderMode,
  GenerationResult,
  SourceArtifact,
  SourceArtifactInput,
  SourceKind,
} from '@/domain/model';
import { renderMermaidSvg } from '@/render/mermaid-client';

interface VersionSummary { id: string; versionNumber: number; createdAt: string }
interface ProjectSummary { id: string; title: string; updatedAt: string; versionCount: number; hasDraft: boolean }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
type ProviderType = 'openai' | 'copilot-sdk' | 'vscode-agent-host';
interface ProviderSelection { baseUrl: string; model: string; providerType: ProviderType }
interface Project {
  id: string; title: string; requirements: string; createdAt: string; updatedAt: string;
  sources: SourceArtifact[]; draft: GenerationResult | null; versions: VersionSummary[]; messages: ChatMessage[];
  providerSettings: ProviderSelection;
}
interface ProviderSettingsView extends ProviderSelection { apiKeyConfigured: boolean }
interface ProviderModelOption { id: string; name: string }
type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
interface GenerationJob {
  id: string; projectId: string; status: GenerationJobStatus; providerSettings: ProviderSelection;
  phase: string; message: string; transcript: string; error: string | null;
  retryOfJobId: string | null;
  createdAt: string; startedAt: string | null; heartbeatAt: string | null; completedAt: string | null; updatedAt: string;
}
type ProviderProgressPhase = 'connecting' | 'selecting-model' | 'preparing' | 'generating' | 'receiving' | 'validating' | 'saving';
interface ProviderProgress { phase: ProviderProgressPhase; message: string; transcriptDelta?: string }
interface ProviderActivity {
  active: boolean;
  kind: 'generation' | 'chat';
  phase: ProviderProgressPhase;
  message: string;
  transcript: string;
  startedAt: number;
  heartbeatAt?: string | null;
}
type ProjectStreamEvent =
  | { type: 'progress'; progress: ProviderProgress }
  | { type: 'result'; project: Project }
  | { type: 'error'; error: string };

const emptyDraft = { title: '', requirements: '', sources: [] as SourceArtifactInput[] };
const providerLabels: Record<ProviderType, string> = {
  openai: 'OpenAI-compatible API',
  'copilot-sdk': 'GitHub Copilot SDK',
  'vscode-agent-host': 'VS Code Copilot bridge',
};
const sourceKind = (name: string): SourceKind | null => {
  const extension = name.toLowerCase().split('.').pop();
  return extension === 'md' ? 'markdown' : extension === 'sql' ? 'sql' : extension === 'ddl' ? 'ddl'
    : extension === 'json' ? 'json' : extension === 'csv' ? 'csv' : extension === 'txt' ? 'text' : null;
};
const errorMessages: Record<string, string> = {
  'provider-timeout': 'The provider did not finish within the configured time. Your model is saved; retry or increase the configured provider timeout.',
  'provider-output-incomplete': 'The provider reached its output limit before completing the model. Increase the provider output limit where supported and retry.',
  'provider-rate-limited': 'The provider quota or rate limit has been reached. Choose another model, wait for quota renewal, or contact your administrator.',
  'provider-not-configured': 'The provider is not authenticated or its model is not configured. Check the server provider settings and sign-in state.',
  'provider-unavailable': 'The configured provider runtime is unavailable. Check the server logs and provider installation.',
  'provider-config-invalid': 'A provider runtime setting is invalid. Check the server environment and restart the server.',
  'provider-settings-invalid': 'Enter a valid HTTP(S) base URL without credentials, query text or a fragment, and a model name.',
  'generation-in-progress': 'A generation job is already running for this project.',
  'generation-interrupted': 'Generation was interrupted when the application stopped. Retry to start a new job.',
  'generation-cancelled': 'Generation was cancelled.',
  'clipboard-image-unavailable': 'Image copy is unavailable in this browser. Use Export PDF instead.',
  'model-export-failed': 'The model could not be exported. Retry after the diagram finishes rendering.',
  'csv-encoding-invalid': 'The CSV text encoding is unsupported or malformed. Use UTF-8, BOM-marked UTF-16, or Windows-1252.',
  'csv-malformed': 'The CSV could not be parsed. Check quoting, commas and embedded line breaks.',
  'csv-empty': 'The CSV must contain at least one data row.',
  'csv-columns-exceeded': 'The CSV has too many columns.',
  'csv-rows-exceeded': 'The CSV has too many rows.',
  'csv-width-inconsistent': 'Every CSV row must contain the same number of columns.',
  'csv-header-invalid': 'CSV column names must be non-empty and unique.',
  'csv-sensitive-columns-invalid': 'The selected sensitive CSV columns are invalid. Reanalyse the file.',
  'csv-analysis-required': 'Review this CSV before saving it.',
  'csv-confirmation-required': 'Confirm every CSV review before generation.',
  'csv-confirmation-stale': 'The CSV changed after review. Reanalyse and confirm it again.',
  'csv-intake-session-expired': 'The CSV review session expired. Reanalyse the CSV.',
  'csv-masking-key-invalid': 'The CSV masking key changed. Reanalyse and confirm each CSV again.',
  'source-too-large': 'A source file exceeds its limit. CSV files may be up to 10 MB; other source files may be up to 1 MB.',
  'sources-too-large': 'The combined source attachments exceed the 50 MB limit. Remove or split one or more files.',
};
const message = (error: unknown) => error instanceof Error ? errorMessages[error.message] ?? error.message : 'Something went wrong.';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'request-failed');
  return body as T;
}

async function requestProjectStream(url: string, init: RequestInit, onProgress: (progress: ProviderProgress) => void): Promise<Project> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/x-ndjson');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body?.error ?? 'request-failed');
  }
  if (!response.body) throw new Error('request-failed');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let project: Project | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: ProjectStreamEvent;
    try { event = JSON.parse(line) as ProjectStreamEvent; }
    catch { throw new Error('request-failed'); }
    if (event.type === 'progress') onProgress(event.progress);
    else if (event.type === 'result') project = event.project;
    else if (event.type === 'error') throw new Error(event.error);
    else throw new Error('request-failed');
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
  } catch (error) {
    try { await reader.cancel(error instanceof Error ? error.message : 'stream-failed'); }
    catch (cancelError) { console.warn('provider stream cancellation failed', cancelError); }
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) consume(buffer);
  if (!project) throw new Error('request-failed');
  return project;
}

const sourceComparison = ({ name, kind, content, csvAnalysis }: SourceArtifactInput) => ({ name, kind, content, csvAnalysis });
const projectIntake = (project: Project, previous: SourceArtifactInput[] = []) => ({
  title: project.title,
  requirements: project.requirements,
  sources: project.sources.map(({ id, name, kind, content, csvAnalysis }, index) => ({
    clientId: previous[index]?.name === name && previous[index]?.kind === kind ? previous[index].clientId : id,
    name,
    kind,
    content,
    csvAnalysis,
  })),
});

const progressSteps: Array<{ phase: ProviderProgressPhase; label: string }> = [
  { phase: 'connecting', label: 'Connect' },
  { phase: 'selecting-model', label: 'Select model' },
  { phase: 'preparing', label: 'Prepare context' },
  { phase: 'generating', label: 'Generate' },
  { phase: 'receiving', label: 'Receive output' },
  { phase: 'validating', label: 'Validate' },
  { phase: 'saving', label: 'Save draft' },
];

function activityFromJob(job: GenerationJob): ProviderActivity {
  const phase = progressSteps.some(step => step.phase === job.phase)
    ? job.phase as ProviderProgressPhase
    : job.status === 'completed' ? 'saving' : 'connecting';
  return {
    active: job.status === 'queued' || job.status === 'running',
    kind: 'generation',
    phase,
    message: job.message,
    transcript: job.transcript,
    startedAt: Date.parse(job.startedAt ?? job.createdAt),
    heartbeatAt: job.heartbeatAt,
  };
}

const ProviderActivityPanel = memo(function ProviderActivityPanel({
  activity,
  onCancel,
  onRetry,
}: {
  activity: ProviderActivity;
  onCancel?: () => void;
  onRetry?: () => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const transcript = useRef<HTMLPreElement>(null);
  const activeStep = Math.max(0, progressSteps.findIndex(step => step.phase === activity.phase));
  const progress = Math.round(((activeStep + (activity.active ? .5 : 0)) / progressSteps.length) * 100);
  const heartbeatAge = activity.heartbeatAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(activity.heartbeatAt)) / 1000))
    : null;
  useEffect(() => {
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - activity.startedAt) / 1000)));
    update();
    if (!activity.active) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [activity.active, activity.startedAt]);
  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [activity.transcript]);
  return <section className={`panel provider-activity${activity.active ? ' active' : ''}`} aria-label="Model generation activity">
    <div className="activity-heading">
      <div><h2>{activity.active ? 'Building your model' : activity.kind === 'generation' ? 'Generation activity' : 'Revision activity'}</h2><p role="status">{activity.message}</p></div>
      <div className="activity-timing" aria-hidden="true"><span className="activity-elapsed">{elapsedSeconds}s elapsed</span>
        {heartbeatAge !== null && <span className={heartbeatAge > 10 ? 'heartbeat stale' : 'heartbeat'}>Heartbeat {heartbeatAge}s ago</span>}</div>
    </div>
    <progress aria-label="Model generation progress" max="100" value={progress} />
    <ol className="activity-steps">
      {progressSteps.map((step, index) => <li className={index < activeStep ? 'complete' : index === activeStep ? 'current' : ''} key={step.phase}>
        <span aria-hidden="true" />{step.label}
      </li>)}
    </ol>
    <details className="activity-transcript" open>
      <summary>Live provider output <span>{activity.transcript.length.toLocaleString()} characters</span></summary>
      <pre ref={transcript} role="log" aria-live="off" aria-label="Live provider transcript">{activity.transcript || 'Waiting for the provider to begin streaming output…'}</pre>
    </details>
    <div className="activity-footer"><p className="activity-safety">The working model is replaced only after the complete response passes schema and domain validation.</p>
      {activity.active && onCancel && <button className="secondary-button" type="button" onClick={onCancel}>Cancel generation</button>}
      {!activity.active && onRetry && <button className="primary-button" type="button" onClick={onRetry}>Retry with current inputs</button>}
    </div>
  </section>;
});

function CsvReview({
  source,
  disabled,
  onHeadersChange,
  onHeaderModeChange,
  onSensitiveChange,
  onConfirm,
  onReanalyse,
  onContentChange,
  onRemove,
}: {
  source: SourceArtifactInput;
  disabled: boolean;
  onHeadersChange: (headers: string[]) => void;
  onHeaderModeChange: (mode: CsvHeaderMode) => void;
  onSensitiveChange: (index: number, sensitive: boolean) => void;
  onConfirm: () => void;
  onReanalyse: () => void;
  onContentChange?: (content: string) => void;
  onRemove: () => void;
}) {
  const analysis = source.csvAnalysis;
  const analysisReady = Boolean(analysis?.contentDigest);
  const status = analysis?.confirmed ? 'Confirmed' : 'Review';
  return <details className={`csv-review${analysis?.confirmed ? ' confirmed' : ' needs-review'}`} role="region" aria-label={`CSV review ${source.name}`}>
    <summary className="csv-file-summary">
      <span className="csv-file-identity"><strong>{source.name}</strong><small>CSV</small></span>
      <span className="csv-file-status"><strong>{analysis?.confirmed ? 'CSV confirmed' : analysisReady ? 'Confirm CSV interpretation' : 'CSV review required'}</strong>
        <small>{analysisReady ? `${analysis!.rowCount.toLocaleString()} rows · ${analysis!.columnCount} columns · sample ${analysis!.sampleRows.length}` : 'Expand to analyse the updated file'}</small></span>
      <span className="count-badge">{status}</span><Icon name="chevron" />
    </summary>
    <div className="csv-review-body">
      {onContentChange && <label>CSV source<textarea aria-label={`Source content ${source.name}`} disabled={disabled} value={source.content} rows={8}
        onChange={event => onContentChange(event.target.value)} /></label>}
      {!analysisReady ? <div className="csv-review-required"><p>The file changed or has not been analysed.</p>
        <button className="secondary-button" type="button" aria-label={`Analyse CSV ${source.name}`} disabled={disabled} onClick={onReanalyse}>Analyse CSV</button></div>
        : <>
      <label>Header interpretation<select aria-label={`Header interpretation for ${source.name}`} value={analysis!.headerMode} disabled={disabled} onChange={event => onHeaderModeChange(event.target.value as CsvHeaderMode)}>
      <option value="first-row">First row contains headers</option>
      <option value="generated">Generate column names; first row is data</option>
    </select></label>
    <div className="csv-header-grid">{analysis!.headers.map((header, index) => <label key={index}>
      Column {index + 1}<input aria-label={`Column ${index + 1} name for ${source.name}`} value={header} disabled={disabled} onChange={event => {
        const headers = [...analysis!.headers];
        headers[index] = event.target.value;
        onHeadersChange(headers);
      }} />
    </label>)}</div>
    <div className="csv-profile-scroll"><table className="csv-profile-table">
      <thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Unique</th><th>Formats</th><th>Sensitive</th></tr></thead>
      <tbody>{analysis!.columns.map(column => {
        const manuallySensitive = analysis!.additionalSensitiveColumns.includes(column.index);
        return <tr key={column.index}><th>{analysis!.headers[column.index]}</th><td>{column.inferredType}</td>
          <td>{Math.round(column.nullRatio * 100)}%</td><td>{Math.round(column.uniqueRatio * 100)}%</td>
          <td>{column.formats.join(', ') || '—'}</td><td><label className="csv-sensitive-choice">
            <input type="checkbox" checked={manuallySensitive} disabled={disabled}
              aria-label={`${manuallySensitive ? 'Unmask' : 'Mask'} ${analysis!.headers[column.index]} in ${source.name}`}
              onChange={event => onSensitiveChange(column.index, event.target.checked)} />
            {manuallySensitive ? 'Masked' : 'Mask values'}
          </label></td></tr>;
      })}</tbody>
    </table></div>
    <div className="csv-sample-heading"><strong>Provider-bound distributed sample</strong><span>{analysis!.sampleRows.length} rows</span></div>
    <div className="csv-profile-scroll"><table className="csv-profile-table"><thead><tr><th>Row</th>
      {analysis!.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead>
      <tbody>{analysis!.sampleRows.map(row => <tr key={row.rowIndex}><th>{row.rowIndex + 1}</th>
        {row.values.map((value, index) => <td key={index}>{value || '—'}</td>)}</tr>)}</tbody></table></div>
    <div className="csv-review-actions"><p>This exact sample will be sent to the configured provider. Values are unchanged unless you mark their column sensitive.</p>
      <div><button className="text-button destructive" type="button" aria-label={`Remove CSV ${source.name}`} disabled={disabled} onClick={onRemove}>Remove CSV</button>
        <button className={analysis!.confirmed ? 'secondary-button' : 'primary-button'} type="button"
          aria-label={`${analysis!.confirmed ? 'Reconfirm' : 'Confirm'} CSV ${source.name}`} disabled={disabled} onClick={onConfirm}>
          {analysis!.confirmed ? 'Reconfirm CSV' : 'Confirm CSV'}
        </button></div></div>
      </>}
      {!analysisReady && <button className="text-button destructive csv-remove-button" type="button"
        aria-label={`Remove CSV ${source.name}`} disabled={disabled} onClick={onRemove}>Remove CSV</button>}
    </div>
  </details>;
}

function MermaidPreview({ source, onRendered }: { source: string; onRendered?: (ready: boolean) => void }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let active = true;
    onRendered?.(false);
    void renderMermaidSvg(`model-${crypto.randomUUID()}`, source).then(result => {
      const document = new DOMParser().parseFromString(result.svg, 'text/html');
      const element = document.querySelector('svg');
      const viewBox = element?.getAttribute('viewBox')?.split(/\s+/u).map(Number);
      if (element && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
        element.setAttribute('width', String(Math.ceil(viewBox[2])));
        element.setAttribute('height', String(Math.ceil(viewBox[3])));
        element.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        element.style.removeProperty('max-width');
      }
      if (active) {
        setSvg(element?.outerHTML ?? result.svg);
        onRendered?.(true);
      }
    }).catch(() => {
      if (active) {
        setSvg('');
        onRendered?.(false);
      }
    });
    return () => { active = false; };
  }, [onRendered, source]);
  return svg ? <div className="mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre className="code-preview">{source}</pre>;
}

function DiagramPreview({ model }: { model: CanonicalModel }) {
  const width = Math.max(900, ...model.entities.map(entity => entity.position.x + 340));
  const height = Math.max(420, ...model.entities.map(entity => entity.position.y + 260));
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  return <svg className="diagram-preview" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet" role="img" aria-label="draw.io model preview">
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

const inlineSvgStyles = (source: Element, target: Element) => {
  const sourceElements = [source, ...source.querySelectorAll('*')];
  const targetElements = [target, ...target.querySelectorAll('*')];
  const properties = [
    'background-color', 'border-color', 'border-radius', 'border-style', 'border-width',
    'color', 'fill', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing',
    'line-height', 'opacity', 'stroke', 'stroke-dasharray', 'stroke-linecap', 'stroke-width',
    'text-align', 'text-anchor', 'white-space',
  ];
  sourceElements.forEach((element, index) => {
    const clone = targetElements[index] as HTMLElement | SVGElement | undefined;
    if (!clone) return;
    const computed = getComputedStyle(element);
    for (const property of properties) {
      const value = computed.getPropertyValue(property);
      if (value) clone.style.setProperty(property, value);
    }
  });
};

async function rasterizeModelSvg(source: SVGSVGElement) {
  const clone = source.cloneNode(true) as SVGSVGElement;
  inlineSvgStyles(source, clone);
  const viewBox = source.viewBox.baseVal;
  const width = Math.max(1, Math.ceil(viewBox.width || source.getBoundingClientRect().width));
  const height = Math.max(1, Math.ceil(viewBox.height || source.getBoundingClientRect().height));
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${width} ${height}`);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const data = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const rasterScale = Math.min(2, 4096 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * rasterScale));
    canvas.height = Math.max(1, Math.round(height * rasterScale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('model-export-failed');
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error('model-export-failed')),
      'image/png',
    ));
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function exportModelPdf(svg: SVGSVGElement, project: Project) {
  if (!project.draft) throw new Error('model-export-failed');
  const draft = project.draft;
  const [{ jsPDF }, raster] = await Promise.all([import('jspdf'), rasterizeModelSvg(svg)]);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 42;
  const contentWidth = pageWidth - margin * 2;
  const bottom = pageHeight - margin;
  const purple = [81, 51, 107] as const;
  const orange = [250, 140, 0] as const;
  let y = margin;
  let currentPageTitle = draft.model.name;

  const pageHeader = (title: string) => {
    currentPageTitle = title;
    pdf.setTextColor(...purple);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text('AustralianSuper Model Foundry', margin, 24);
    pdf.setDrawColor(...orange);
    pdf.setLineWidth(1.5);
    pdf.line(margin, 30, pageWidth - margin, 30);
    pdf.setFontSize(18);
    pdf.text(title, margin, margin + 14);
    y = margin + 34;
  };
  const ensureSpace = (height: number, title = currentPageTitle) => {
    if (y + height <= bottom) return;
    pdf.addPage();
    pageHeader(title);
  };
  const paragraph = (text: string, options: { size?: number; indent?: number; bold?: boolean } = {}) => {
    const indent = options.indent ?? 0;
    const size = options.size ?? 10;
    const lineHeight = size * 1.35;
    const lines = pdf.splitTextToSize(text || '—', contentWidth - indent) as string[];
    const applyStyle = () => {
      pdf.setTextColor(46, 46, 46);
      pdf.setFont('helvetica', options.bold ? 'bold' : 'normal');
      pdf.setFontSize(size);
    };
    let offset = 0;
    while (offset < lines.length) {
      if (y + lineHeight > bottom) {
        pdf.addPage();
        pageHeader(currentPageTitle);
      }
      applyStyle();
      const lineCount = Math.max(1, Math.floor((bottom - y) / lineHeight));
      const chunk = lines.slice(offset, offset + lineCount);
      pdf.text(chunk, margin + indent, y);
      y += chunk.length * lineHeight;
      offset += chunk.length;
      if (offset < lines.length) {
        pdf.addPage();
        pageHeader(currentPageTitle);
      }
    }
    y += 7;
  };
  const section = (title: string) => {
    currentPageTitle = title;
    ensureSpace(30);
    y += 5;
    pdf.setTextColor(...purple);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.text(title, margin, y);
    y += 18;
  };

  pdf.setProperties({ title: `${draft.model.name} data model`, subject: 'AustralianSuper Model Foundry export' });
  pageHeader(draft.model.name);
  paragraph(draft.model.businessDefinition, { size: 11 });
  const widthFitHeight = raster.height * contentWidth / raster.width;
  if (bottom - y < Math.min(240, widthFitHeight)) {
    pdf.addPage();
    pageHeader(`${draft.model.name} diagram`);
  }
  const imageScale = Math.min(contentWidth / raster.width, (bottom - y) / raster.height);
  const imageWidth = raster.width * imageScale;
  const imageHeight = raster.height * imageScale;
  pdf.addImage(new Uint8Array(await raster.blob.arrayBuffer()), 'PNG',
    margin + (contentWidth - imageWidth) / 2, y, imageWidth, imageHeight, undefined, 'FAST');

  pdf.addPage();
  pageHeader('Entities');
  for (const entity of draft.model.entities) {
    paragraph(entity.name, { size: 12, bold: true });
    paragraph(entity.businessDefinition, { indent: 10 });
    for (const attribute of entity.attributes) {
      const key = attribute.key === 'NONE' ? '' : `[${attribute.key}] `;
      const reference = attribute.references
        ? ` References ${attribute.references.entityId}.${attribute.references.attributeId}.`
        : '';
      paragraph(`- ${key}${attribute.name}: ${attribute.dataType} (${attribute.required ? 'required' : 'optional'}). ${attribute.businessDefinition}${reference}`, { size: 9, indent: 18 });
    }
    y += 4;
  }

  section('Relationships');
  const entities = new Map(draft.model.entities.map(entity => [entity.id, entity.name]));
  for (const relationship of draft.model.relationships) {
    paragraph(`${relationship.name}: ${entities.get(relationship.fromEntityId) ?? relationship.fromEntityId} (${relationship.fromCardinality}) -> ${entities.get(relationship.toEntityId) ?? relationship.toEntityId} (${relationship.toCardinality})`, { size: 9, indent: 10 });
  }
  section('Validation rules');
  for (const rule of draft.model.rules) {
    paragraph(rule.name, { size: 11, bold: true });
    paragraph(`Expression: ${rule.expression}`, { size: 9, indent: 10 });
    paragraph(rule.businessDefinition, { size: 9, indent: 10 });
    paragraph(`Applies to: ${rule.entityIds.map(id => entities.get(id) ?? id).join(', ') || 'No entities specified'}`, { size: 9, indent: 10 });
  }
  section('Assumptions');
  for (const item of draft.assumptions) paragraph(`- ${item}`, { size: 9, indent: 10 });
  section('Warnings');
  for (const item of draft.warnings) paragraph(`- ${item}`, { size: 9, indent: 10 });

  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-|-$)/gu, '') || 'data-model';
  pdf.save(`${slug}-data-model.pdf`);
}

type IconName = 'arrow' | 'chat' | 'chevron' | 'close' | 'copy' | 'database' | 'download' | 'menu' | 'minus' | 'plus' | 'reset' | 'settings' | 'shield' | 'trash';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    chat: <><path d="M5 17 3 21l5-2h8a5 5 0 0 0 5-5V8a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v6a5 5 0 0 0 2 4Z" /><path d="M8 10h8" /><path d="M8 14h5" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
    database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
    minus: <path d="M5 12h14" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    reset: <><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v6h6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.37.33.7.6 1 .3.3.68.42 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>,
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8.1 7 10 4.1-1.9 7-5.4 7-10V6l-7-3Z" />,
    trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m7 7 1 13h8l1-13" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const MODEL_VIEW_DEFAULT = { scale: .5, x: 0, y: 0 };
const clampScale = (value: number) => Math.min(2.5, Math.max(.25, Math.round(value * 1000) / 1000));

interface ModelCanvasControls {
  scale: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

function InteractiveModelCanvas({
  children,
  renderToolbar,
}: {
  children: ReactNode;
  renderToolbar: (controls: ModelCanvasControls) => ReactNode;
}) {
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
          x: Math.round(anchorX - ((anchorX - current.x) / current.scale) * scale),
          y: Math.round(anchorY - ((anchorY - current.y) / current.scale) * scale),
        };
      });
    };
    target.addEventListener('wheel', handleWheel, { passive: false });
    return () => target.removeEventListener('wheel', handleWheel);
  }, []);

  const zoomFromCentre = (delta: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    const anchorX = rect ? rect.width / 2 : 0;
    const anchorY = rect ? rect.height / 2 : 0;
    setView(current => {
      const scale = clampScale(current.scale + delta);
      return {
        scale,
        x: Math.round(anchorX - ((anchorX - current.x) / current.scale) * scale),
        y: Math.round(anchorY - ((anchorY - current.y) / current.scale) * scale),
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
    else if (event.key === '+' || event.key === '=') zoomFromCentre(.25);
    else if (event.key === '-') zoomFromCentre(-.25);
    else if (event.key === '0') setView(MODEL_VIEW_DEFAULT);
    else return;
    event.preventDefault();
  };

  return <div className="model-canvas-block">
    {renderToolbar({
      scale: view.scale,
      zoomIn: () => zoomFromCentre(.25),
      zoomOut: () => zoomFromCentre(-.25),
      reset: () => setView(MODEL_VIEW_DEFAULT),
    })}
    <span className="sr-only" id="model-canvas-help">Scroll to zoom, drag to move, use arrow keys to pan, plus and minus to zoom, or zero to reset.</span>
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
  const [view, setView] = useState<'workspace' | 'settings'>('workspace');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsView | null>(null);
  const [settingsModels, setSettingsModels] = useState<ProviderModelOption[]>([]);
  const [projectModels, setProjectModels] = useState<ProviderModelOption[]>([]);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(new Set());
  const [pendingChatMessage, setPendingChatMessage] = useState<ChatMessage | null>(null);
  const [providerActivity, setProviderActivity] = useState<ProviderActivity | null>(null);
  const [generationJob, setGenerationJob] = useState<GenerationJob | null>(null);
  const [projectProviderDirty, setProjectProviderDirty] = useState(false);
  const [modelExportBusy, setModelExportBusy] = useState<'copy' | 'pdf' | null>(null);
  const [csvAnalysisPending, setCsvAnalysisPending] = useState<Set<string>>(new Set());
  const [sourceUploadBusy, setSourceUploadBusy] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [mermaidExportReady, setMermaidExportReady] = useState(false);
  const editRevision = useRef(0);
  const chatBubble = useRef<HTMLButtonElement>(null);
  const chatTranscript = useRef<HTMLOListElement>(null);
  const modelExportSource = useRef<HTMLDivElement>(null);
  const providerRequest = useRef(0);
  const providerAbort = useRef<AbortController | null>(null);
  const providerTranscript = useRef('');
  const providerTranscriptFrame = useRef<number | null>(null);
  const generationPoll = useRef(0);
  const intakeEpoch = useRef(0);
  const sourceUploadInFlight = useRef(false);
  const csvAnalysisRequests = useRef(new Map<string, number>());
  const providerSelectionRequest = useRef(0);

  const refreshProjects = async () => setProjects(await requestJson<ProjectSummary[]>('/api/projects'));
  const loadProviderModels = async (providerType: ProviderType) =>
    requestJson<ProviderModelOption[]>(`/api/settings/provider/models?providerType=${encodeURIComponent(providerType)}`);
  useEffect(() => { void refreshProjects().catch(error => setError(message(error))); }, []);
  useEffect(() => {
    sourceUploadInFlight.current = false;
    setSourceUploadBusy(false);
    setExpandedEntities(new Set());
    setPendingChatMessage(null);
    setCsvAnalysisPending(new Set());
    csvAnalysisRequests.current.clear();
    setChatOpen(false);
  }, [project?.id]);
  useEffect(() => {
    if (!chatOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setChatOpen(false);
      window.requestAnimationFrame(() => chatBubble.current?.focus());
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [chatOpen]);
  useEffect(() => {
    if (!project?.draft) { setExpandedEntities(new Set()); return; }
    setExpandedEntities(current => {
      const valid = new Set(project.draft!.model.entities.map(entity => entity.id));
      return new Set([...current].filter(id => valid.has(id)));
    });
  }, [project?.draft?.model.entities]);
  useEffect(() => {
    if (!chatTranscript.current) return;
    chatTranscript.current.scrollTop = chatTranscript.current.scrollHeight;
  }, [project?.messages.length, pendingChatMessage]);
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
  useEffect(() => () => {
    providerAbort.current?.abort();
    if (providerTranscriptFrame.current !== null) window.cancelAnimationFrame(providerTranscriptFrame.current);
  }, []);

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

  const cancelProviderActivity = () => {
    providerRequest.current += 1;
    generationPoll.current += 1;
    providerAbort.current?.abort();
    providerAbort.current = null;
    if (providerTranscriptFrame.current !== null) window.cancelAnimationFrame(providerTranscriptFrame.current);
    providerTranscriptFrame.current = null;
    providerTranscript.current = '';
    setProviderActivity(null);
    setGenerationJob(null);
  };

  const watchGenerationJob = async (initial: GenerationJob, expectedEpoch = intakeEpoch.current) => {
    const pollId = generationPoll.current + 1;
    generationPoll.current = pollId;
    let job = initial;
    let pollFailures = 0;
    while (generationPoll.current === pollId && intakeEpoch.current === expectedEpoch) {
      setGenerationJob(job);
      setProviderActivity(activityFromJob(job));
      setStatus(job.message);
      if (job.status === 'completed') {
        const updated = await requestJson<Project>(`/api/projects/${job.projectId}`);
        if (generationPoll.current !== pollId || intakeEpoch.current !== expectedEpoch) return;
        setProject(updated); setIntake(current => projectIntake(updated, current.sources)); setGenerationJob(null); setProviderActivity(null); setDirty(false); setStatus('Draft ready');
        await refreshProjects();
        return;
      }
      if (job.status === 'failed' || job.status === 'interrupted' || job.status === 'cancelled') {
        if (job.error) setError(message(new Error(job.error)));
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, pollFailures ? Math.min(5000, pollFailures * 1000) : 1000));
      if (generationPoll.current !== pollId || intakeEpoch.current !== expectedEpoch) return;
      try {
        job = await requestJson<GenerationJob>(`/api/generation-jobs/${job.id}`);
        pollFailures = 0;
      } catch (error) {
        pollFailures += 1;
        setStatus('Reconnecting to the generation job…');
        if (pollFailures >= 12) {
          setError(message(error));
          stopProviderActivity('Generation status is temporarily unavailable. Reload to reconnect to the durable job.');
          return;
        }
      }
    }
  };

  const resumeLatestGeneration = async (projectId: string, expectedEpoch: number) => {
    const response = await fetch(`/api/projects/${projectId}/generation-jobs`);
    if (intakeEpoch.current !== expectedEpoch) return;
    if (response.status === 204) return;
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body?.error ?? 'request-failed');
    }
    const job = await response.json() as GenerationJob;
    if (job.status !== 'completed' && intakeEpoch.current === expectedEpoch) void watchGenerationJob(job, expectedEpoch).catch(error => {
      if (intakeEpoch.current !== expectedEpoch) return;
      setError(message(error));
      stopProviderActivity('Generation status is unavailable. Reload to reconnect to the durable job.');
    });
  };

  const loadProject = async (id: string) => {
    const epoch = intakeEpoch.current + 1;
    intakeEpoch.current = epoch;
    sourceUploadInFlight.current = false;
    csvAnalysisRequests.current.clear();
    cancelProviderActivity();
    setError(''); setStatus('Loading…'); setView('workspace');
    try {
      const loaded = await requestJson<Project>(`/api/projects/${id}`);
      if (intakeEpoch.current !== epoch) return;
      setProject(loaded); setIntake(projectIntake(loaded)); setProjectProviderDirty(false); setStatus('Ready');
      const models = await loadProviderModels(loaded.providerSettings.providerType).catch(() => []);
      if (intakeEpoch.current !== epoch) return;
      setProjectModels(models);
      await resumeLatestGeneration(id, epoch);
    }
    catch (error) {
      if (intakeEpoch.current !== epoch) return;
      setError(message(error)); setStatus('Load failed');
    }
  };

  const goHome = () => {
    intakeEpoch.current += 1;
    sourceUploadInFlight.current = false;
    csvAnalysisRequests.current.clear();
    setSourceUploadBusy(false);
    cancelProviderActivity();
    setView('workspace'); setProject(null); setIntake(emptyDraft); setPendingChatMessage(null); setProjectProviderDirty(false); setError(''); setStatus('Ready'); setSettingsStatus('');
  };

  const openProviderSettings = async () => {
    intakeEpoch.current += 1;
    sourceUploadInFlight.current = false;
    csvAnalysisRequests.current.clear();
    setSourceUploadBusy(false);
    setView('settings'); setError(''); setSettingsStatus('Loading settings…');
    try {
      const settings = await requestJson<ProviderSettingsView>('/api/settings/provider');
      setProviderSettings(settings);
      setSettingsModels(await loadProviderModels(settings.providerType).catch(() => []));
      setSettingsStatus('');
    } catch (error) { setError(message(error)); setSettingsStatus('Settings unavailable'); }
  };

  const saveCurrentProviderSettings = async () => {
    if (!providerSettings) return;
    setError(''); setSettingsStatus('Saving settings…');
    try {
      setProviderSettings(await requestJson<ProviderSettingsView>('/api/settings/provider', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: providerSettings.providerType,
          baseUrl: providerSettings.baseUrl,
          model: providerSettings.model,
        }),
      }));
      setSettingsStatus('Settings saved');
    } catch (error) { setError(message(error)); setSettingsStatus('Settings not saved'); }
  };

  const changeDefaultProvider = async (providerType: ProviderType) => {
    setSettingsStatus('Loading provider…');
    try {
      const settings = await requestJson<ProviderSettingsView>(
        `/api/settings/provider?providerType=${encodeURIComponent(providerType)}`,
      );
      setProviderSettings(settings);
      setSettingsModels(await loadProviderModels(providerType));
      setSettingsStatus('');
    } catch (error) {
      setError(message(error));
      setSettingsStatus('Provider unavailable');
    }
  };

  const changeProjectProvider = async (providerType: ProviderType) => {
    if (!project) return;
    const epoch = intakeEpoch.current;
    const projectId = project.id;
    const requestId = providerSelectionRequest.current + 1;
    providerSelectionRequest.current = requestId;
    setStatus('Loading provider…');
    setProjectModels([]);
    try {
      const settings = await requestJson<ProviderSettingsView>(
        `/api/settings/provider?providerType=${encodeURIComponent(providerType)}`,
      );
      if (intakeEpoch.current !== epoch || providerSelectionRequest.current !== requestId) return;
      const models = await loadProviderModels(providerType);
      if (intakeEpoch.current !== epoch || providerSelectionRequest.current !== requestId) return;
      setProject(current => current?.id === projectId ? { ...current, providerSettings: {
        providerType: settings.providerType, baseUrl: settings.baseUrl, model: settings.model,
      } } : current);
      setProjectProviderDirty(true);
      setProjectModels(models);
      setStatus('Provider selected; save generation inputs to apply');
    } catch (error) {
      if (intakeEpoch.current !== epoch || providerSelectionRequest.current !== requestId) return;
      setError(message(error));
      setStatus('Provider unavailable');
    }
  };

  const filesSelected = async (files: FileList | null) => {
    if (!files || sourceUploadInFlight.current) return;
    const epoch = intakeEpoch.current;
    sourceUploadInFlight.current = true;
    setSourceUploadBusy(true);
    setError(''); setStatus('Analysing source files…');
    try {
      const sources: SourceArtifactInput[] = [];
      let intakeSessionId = intake.sources.find(source => source.kind === 'csv')?.csvAnalysis?.intakeSessionId ?? null;
      for (const file of [...files]) {
        if (intakeEpoch.current !== epoch) return;
        const kind = sourceKind(file.name);
        if (!kind) throw new Error(`Unsupported file: ${file.name}`);
        if (kind === 'csv') {
          const result = await requestCsvAnalysis(file, { name: file.name, projectId: project?.id, intakeSessionId });
          if (intakeEpoch.current !== epoch) return;
          intakeSessionId = result.analysis.intakeSessionId;
          sources.push({ clientId: crypto.randomUUID(), name: file.name, kind, content: result.content, csvAnalysis: result.analysis });
        } else {
          sources.push({ clientId: crypto.randomUUID(), name: file.name, kind, content: await file.text() });
        }
      }
      if (intakeEpoch.current === epoch) {
        setIntake(current => ({ ...current, sources: [...current.sources, ...sources] }));
        setStatus('Source files ready');
      }
    } catch (error) {
      if (intakeEpoch.current === epoch) {
        setError(message(error));
        setStatus('Source analysis failed');
      }
    }
    finally {
      if (intakeEpoch.current === epoch) {
        sourceUploadInFlight.current = false;
        setSourceUploadBusy(false);
      }
    }
  };

  const requestCsvAnalysis = async (
    file: Blob,
    options: {
      name?: string;
      projectId?: string;
      intakeSessionId?: string | null;
      headerMode?: CsvHeaderMode;
      headers?: string[];
      additionalSensitiveColumns?: number[];
      confirmed?: boolean;
    },
  ) => {
    const form = new FormData();
    const fileName = options.name ?? (file instanceof File ? file.name : '');
    if (!fileName) throw new Error('source-invalid');
    form.set('file', file, fileName);
    if (options.projectId) form.set('projectId', options.projectId);
    if (options.intakeSessionId) form.set('intakeSessionId', options.intakeSessionId);
    if (options.headerMode) form.set('headerMode', options.headerMode);
    if (options.headers) form.set('headers', JSON.stringify(options.headers));
    if (options.additionalSensitiveColumns) form.set('additionalSensitiveColumns', JSON.stringify(options.additionalSensitiveColumns));
    if (options.confirmed) form.set('confirmed', 'true');
    const response = await fetch('/api/csv-analysis', { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? 'request-failed');
    return body as { content: string; analysis: CsvAnalysis };
  };

  const analyseCsvSource = async (
    index: number,
    changes: Partial<Pick<CsvAnalysis, 'headerMode' | 'headers' | 'additionalSensitiveColumns'>> = {},
    confirmed = false,
  ) => {
    const source = intake.sources[index];
    if (!source || source.kind !== 'csv') return;
    if (!source.clientId) throw new Error('csv-analysis-required');
    const clientId = source.clientId;
    const sourceContent = source.content;
    const epoch = intakeEpoch.current;
    const requestId = (csvAnalysisRequests.current.get(clientId) ?? 0) + 1;
    csvAnalysisRequests.current.set(clientId, requestId);
    const current = source.csvAnalysis;
    setCsvAnalysisPending(pending => new Set(pending).add(clientId));
    setError(''); setStatus(confirmed ? 'Confirming CSV…' : 'Analysing CSV…');
    try {
      const result = await requestCsvAnalysis(new Blob([sourceContent], { type: 'text/csv' }), {
        name: source.name,
        projectId: project?.id,
        intakeSessionId: current?.intakeSessionId
          ?? intake.sources.find(candidate => candidate.kind === 'csv')?.csvAnalysis?.intakeSessionId,
        headerMode: changes.headerMode ?? current?.headerMode,
        headers: changes.headers ?? current?.headers,
        additionalSensitiveColumns: changes.additionalSensitiveColumns ?? current?.additionalSensitiveColumns,
        confirmed,
      });
      if (intakeEpoch.current !== epoch || csvAnalysisRequests.current.get(clientId) !== requestId) return;
      setIntake(value => ({
        ...value,
        sources: value.sources.map(candidate => candidate.clientId === clientId && candidate.content === sourceContent
          ? { ...candidate, content: result.content, csvAnalysis: result.analysis }
          : candidate),
      }));
      setStatus(result.analysis.confirmed ? 'CSV confirmed' : 'CSV ready for review');
    } catch (error) {
      if (intakeEpoch.current === epoch && csvAnalysisRequests.current.get(clientId) === requestId) {
        setError(message(error)); setStatus('CSV analysis failed');
      }
    }
    finally {
      if (intakeEpoch.current === epoch && csvAnalysisRequests.current.get(clientId) === requestId) {
        csvAnalysisRequests.current.delete(clientId);
        setCsvAnalysisPending(pending => {
          const next = new Set(pending);
          next.delete(clientId);
          return next;
        });
      }
    }
  };

  const persistIntake = async () => {
    const epoch = intakeEpoch.current;
    const target = project
      ? await requestJson<Project>(`/api/projects/${project.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...intake, providerSettings: project.providerSettings }),
      })
      : await requestJson<Project>('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intake),
      });
    if (intakeEpoch.current !== epoch) return null;
    setProject(target); setIntake(current => projectIntake(target, current.sources));
    setProjectProviderDirty(false);
    return target;
  };

  const beginProviderActivity = (kind: ProviderActivity['kind'], initialMessage: string) => {
    providerAbort.current?.abort();
    const controller = new AbortController();
    const requestId = providerRequest.current + 1;
    providerRequest.current = requestId;
    providerAbort.current = controller;
    providerTranscript.current = '';
    const startedAt = Date.now();
    setProviderActivity({ active: true, kind, phase: 'connecting', message: initialMessage, transcript: '', startedAt });
    return { controller, requestId };
  };

  const updateProviderActivity = (progress: ProviderProgress) => {
    if (progress.transcriptDelta) {
      providerTranscript.current = `${providerTranscript.current}${progress.transcriptDelta}`.slice(-100_000);
      if (providerTranscriptFrame.current === null) providerTranscriptFrame.current = window.requestAnimationFrame(() => {
        const transcript = providerTranscript.current;
        providerTranscriptFrame.current = null;
        setProviderActivity(current => current ? {
          ...current, phase: 'receiving', message: 'Receiving live model output…', transcript,
        } : current);
      });
      return;
    }
    if (providerTranscriptFrame.current !== null) window.cancelAnimationFrame(providerTranscriptFrame.current);
    providerTranscriptFrame.current = null;
    setStatus(progress.message);
    setProviderActivity(current => current ? {
      ...current,
      phase: progress.phase,
      message: progress.message,
      transcript: providerTranscript.current,
    } : current);
  };

  const stopProviderActivity = (message: string) => {
    if (providerTranscriptFrame.current !== null) window.cancelAnimationFrame(providerTranscriptFrame.current);
    providerTranscriptFrame.current = null;
    setProviderActivity(current => current ? { ...current, active: false, message, transcript: providerTranscript.current } : current);
  };

  const saveIntake = async () => {
    setError(''); setStatus(project ? 'Saving changes…' : 'Saving model…');
    try {
      const target = await persistIntake();
      if (!target) return;
      setStatus(project ? 'Changes saved' : 'Model saved');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Save failed'); }
  };

  const generate = async (retryOfJobId: string | null = null) => {
    setError(''); setStatus('Preparing draft…');
    try {
      if (!csvInputsConfirmed) throw new Error('csv-confirmation-required');
      if (project?.draft && dirty) {
        const revision = editRevision.current;
        await requestJson<GenerationResult>(`/api/projects/${project.id}/draft`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.draft),
        });
        if (editRevision.current === revision) setDirty(false);
      }
      const target = await persistIntake();
      if (!target) return;
      const epoch = intakeEpoch.current;
      const job = await requestJson<GenerationJob>(`/api/projects/${target.id}/generation-jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clarification: null, retryOfJobId }),
      });
      if (intakeEpoch.current !== epoch) return;
      setGenerationJob(job);
      setProviderActivity(activityFromJob(job));
      void watchGenerationJob(job, epoch).catch(error => {
        if (intakeEpoch.current !== epoch) return;
        setError(message(error));
        stopProviderActivity('Generation status is unavailable. Reload to reconnect to the durable job.');
      });
      await refreshProjects();
    } catch (error) {
      setError(message(error)); setStatus('Generation stopped'); stopProviderActivity('Generation stopped before a valid model was produced.');
      await refreshProjects().catch(() => undefined);
    }
  };

  const cancelGeneration = async () => {
    if (!generationJob || generationJob.status !== 'queued' && generationJob.status !== 'running') return;
    const epoch = intakeEpoch.current;
    const jobId = generationJob.id;
    setStatus('Cancelling generation…');
    try {
      const cancelled = await requestJson<GenerationJob>(`/api/generation-jobs/${jobId}`, { method: 'DELETE' });
      if (intakeEpoch.current !== epoch) return;
      generationPoll.current += 1;
      setGenerationJob(cancelled);
      setProviderActivity(activityFromJob(cancelled));
      setStatus('Generation cancelled');
    } catch (error) {
      if (intakeEpoch.current !== epoch) return;
      setError(message(error));
      setStatus('Cancellation failed');
    }
  };

  const removeProject = async () => {
    if (!project) return;
    const epoch = intakeEpoch.current;
    const projectId = project.id;
    const versionWarning = project.versions.length ? ` and its ${project.versions.length} saved version${project.versions.length === 1 ? '' : 's'}` : '';
    if (!window.confirm(`Delete “${project.title}”${versionWarning}? This cannot be undone.`)) return;
    setError(''); setStatus('Deleting model…');
    try {
      await requestJson<void>(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (intakeEpoch.current !== epoch) {
        await refreshProjects();
        return;
      }
      setProject(null); setIntake(emptyDraft); setDirty(false); setStatus('Model deleted');
      await refreshProjects();
    } catch (error) {
      if (intakeEpoch.current !== epoch) return;
      setError(message(error)); setStatus('Delete failed');
    }
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

  const renderedModelSvg = () => {
    const svg = modelExportSource.current?.querySelector('svg');
    if (!(svg instanceof SVGSVGElement)) throw new Error('model-export-failed');
    return svg;
  };

  const copyModelImage = async () => {
    setError(''); setModelExportBusy('copy'); setStatus('Preparing model image…');
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard-image-unavailable');
      const { blob } = await rasterizeModelSvg(renderedModelSvg());
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus('Model image copied');
    } catch (error) {
      setError(message(error));
      setStatus('Copy failed');
    } finally {
      setModelExportBusy(null);
    }
  };

  const exportModel = async () => {
    if (!project?.draft) return;
    setError(''); setModelExportBusy('pdf'); setStatus('Preparing PDF…');
    try {
      await exportModelPdf(renderedModelSvg(), project);
      setStatus('PDF exported');
    } catch (error) {
      setError(message(error));
      setStatus('Export failed');
    } finally {
      setModelExportBusy(null);
    }
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
    const outgoingMessage = chatMessage.trim();
    if (!project?.draft || !outgoingMessage || pendingChatMessage) return;
    setPendingChatMessage({
      id: `pending-${crypto.randomUUID()}`, role: 'user', content: outgoingMessage, createdAt: new Date().toISOString(),
    });
    setChatMessage('');
    setError(''); setStatus('Updating model with assistant…');
    const operation = beginProviderActivity('chat', 'Connecting to the configured provider…');
    try {
      if (dirty) {
        await requestJson(`/api/projects/${project.id}/draft`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.draft),
        });
        setDirty(false);
      }
      if (generationInputsDirty && !await persistIntake()) return;
      const updated = await requestProjectStream(`/api/projects/${project.id}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: outgoingMessage }),
        signal: operation.controller.signal,
      }, updateProviderActivity);
      if (providerRequest.current !== operation.requestId) return;
      setProject(updated); setPendingChatMessage(null); setProviderActivity(null); setDirty(false); setStatus('Model updated from chat');
      providerAbort.current = null;
      await refreshProjects().catch(() => undefined);
    } catch (error) {
      if (providerRequest.current !== operation.requestId) return;
      setPendingChatMessage(null);
      setChatMessage(current => current.trim() ? current : outgoingMessage);
      setError(message(error)); setStatus('Chat update stopped'); stopProviderActivity('Chat update stopped before a valid model revision was produced.');
      providerAbort.current = null;
    }
  };

  const saveGenerationInputs = async () => {
    if (!project?.draft || !generationInputsDirty) return;
    setError(''); setStatus('Saving generation inputs…');
    try {
      if (dirty) {
        await requestJson(`/api/projects/${project.id}/draft`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.draft),
        });
        setDirty(false);
      }
      if (!await persistIntake()) return;
      setStatus('Generation inputs saved');
      await refreshProjects();
    } catch (error) { setError(message(error)); setStatus('Generation inputs not saved'); }
  };

  const latest = project?.versions[0]?.versionNumber ?? null;
  const downloadStem = project?.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-|-$)/gu, '') || 'model';
  const foreignKeyTargets = project?.draft?.model.entities.flatMap(entity => entity.attributes
    .filter(attribute => attribute.key === 'PK')
    .map(attribute => ({ value: `${entity.id}:${attribute.id}`, label: `${entity.name}.${attribute.name}` }))) ?? [];
  // Background draft persistence must not lock the editor or prevent an explicit
  // version save; saveVersion writes the latest in-memory draft before snapshotting.
  const busy = providerActivity?.active || status.endsWith('…') && status !== 'Saving draft…';
  const generationLocked = Boolean(providerActivity?.active);
  const retryOriginId = generationJob && ['failed', 'interrupted', 'cancelled'].includes(generationJob.status)
    ? generationJob.id : null;
  const csvInputsAnalysed = intake.sources.every(source => source.kind !== 'csv' || Boolean(source.csvAnalysis?.contentDigest));
  const csvInputsConfirmed = intake.sources.every(source => source.kind !== 'csv' || source.csvAnalysis?.confirmed);
  const generationInputsDirty = Boolean(project?.draft && (
    intake.requirements !== project.requirements
    || JSON.stringify(intake.sources.map(sourceComparison)) !== JSON.stringify(project.sources.map(sourceComparison))
    || projectProviderDirty
  ));
  return <main className="app-shell">
    <a className="skip-link" href="#work-area">Skip to work area</a>
    <header className="product-header">
      <button className="brand-lockup brand-button" type="button" aria-label="Return home to Model Foundry" onClick={goHome}><span className="brand-mark"><Icon name="database" /></span><span><strong>Model Foundry</strong><small>Data Model Design Space</small></span></button>
      <img className="australiansuper-logo" src="/australiansuper-logo.svg" alt="AustralianSuper" />
    </header>
    {!project && view === 'workspace' && <header className="hero">
      <div><h1>Turn complex requirements into models people can trust.</h1>
        <p>Develop one canonical model, surface uncertainty, and export consistent Mermaid and draw.io representations.</p></div>
    </header>}

    <div className={`workspace${sidebarCollapsed ? ' sidebar-collapsed' : ''}${project ? ' has-project' : ''}`}>
      <aside className="sidebar panel" aria-label="Workspace navigation">
        <button className="sidebar-collapse" type="button" aria-label={sidebarCollapsed ? 'Expand workspace sidebar' : 'Collapse workspace sidebar'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}><Icon name="menu" /><span>{sidebarCollapsed ? 'Expand' : 'Collapse'}</span></button>
        <div className="sidebar-heading"><div className="sidebar-copy"><h2>Models</h2></div><button className="secondary-button compact-button sidebar-action" aria-label="New model" onClick={goHome}><Icon name="plus" /><span>New model</span></button></div>
        <div className="project-list">{projects.length ? projects.map(item => <button className={`project-item ${project?.id === item.id ? 'active' : ''}`} aria-pressed={project?.id === item.id} key={item.id} onClick={() => void loadProject(item.id)}>
          <strong>{item.title}</strong><span>{item.versionCount} version{item.versionCount === 1 ? '' : 's'} · {item.hasDraft ? 'working draft' : 'empty'}</span>
        </button>) : <div className="empty-state"><Icon name="database" /><p>No saved models yet</p><span>Create your first model from requirements or source files.</span></div>}</div>
        <nav className="sidebar-menu" aria-label="Application"><button type="button" className={view === 'settings' ? 'active' : ''} aria-label="Provider settings" aria-pressed={view === 'settings'} onClick={() => void openProviderSettings()}><Icon name="settings" /><span>Settings</span></button></nav>
        <div className="privacy-note"><span className="privacy-icon"><Icon name="shield" /></span><div><strong>Before you generate</strong><p>Generate sends the supplied material to the configured provider through the server. Credentials stay server-side.</p></div></div>
      </aside>

      <section className="main-column" id="work-area" tabIndex={-1}>
        {error && <div className="error-banner" role="alert"><strong>Action stopped</strong><span>{error}</span></div>}
        {view === 'settings' ? <section className="panel settings-card">
          <div className="section-heading"><div><h1>Provider settings</h1><p>{providerSettings?.providerType === 'vscode-agent-host' ? 'Choose a model exposed by the local Data Model Agent VS Code extension. Changes apply to the next generation or chat request.' : providerSettings?.providerType === 'copilot-sdk' ? 'Choose a model available through the signed-in GitHub Copilot account. Changes apply to the next generation or chat request.' : 'Choose an OpenAI-compatible Responses API endpoint and model. Changes apply to the next generation or chat request.'}</p></div><span className="status-dot" aria-live="polite">{settingsStatus || 'Ready'}</span></div>
          {providerSettings && <>
            <label>Provider<select aria-label="Provider" value={providerSettings.providerType} onChange={event => void changeDefaultProvider(event.target.value as ProviderType)}>
              {(Object.entries(providerLabels) as Array<[ProviderType, string]>).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select></label>
            {providerSettings.providerType === 'openai' && <label>Provider base URL<input aria-label="Provider base URL" type="url" value={providerSettings.baseUrl} onChange={event => setProviderSettings({ ...providerSettings, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>}
            <label>Provider model{settingsModels.length
              ? <select aria-label="Provider model" value={providerSettings.model} onChange={event => setProviderSettings({ ...providerSettings, model: event.target.value })}>
                {!settingsModels.some(model => model.id === providerSettings.model) && <option value={providerSettings.model}>{providerSettings.model}</option>}
                {settingsModels.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
              : <input aria-label="Provider model" value={providerSettings.model} onChange={event => setProviderSettings({ ...providerSettings, model: event.target.value })} placeholder="Provider model name" />}</label>
            {providerSettings.providerType === 'vscode-agent-host'
              ? <div className="credential-status configured"><Icon name="shield" /><div><strong>VS Code Copilot bridge selected</strong><p>The local VS Code extension uses the signed-in Copilot model through <code>vscode.lm</code>. No credential leaves VS Code.</p></div></div>
              : providerSettings.providerType === 'copilot-sdk'
              ? <div className="credential-status configured"><Icon name="shield" /><div><strong>GitHub Copilot OAuth selected</strong><p>The server uses credentials stored by the bundled Copilot CLI. No token is displayed or stored in this application.</p></div></div>
              : <div className={`credential-status ${providerSettings.apiKeyConfigured ? 'configured' : ''}`}><Icon name="shield" /><div><strong>Server-side API key {providerSettings.apiKeyConfigured ? 'configured' : 'not configured'}</strong><p>The API key is read from <code>OPENAI_API_KEY</code> and is never displayed or stored here.</p></div></div>}
            <div className="settings-actions"><button className="primary-button" type="button" onClick={() => void saveCurrentProviderSettings()}>Save settings</button><button className="secondary-button" type="button" onClick={goHome}>Back to models</button></div>
          </>}
        </section> : project && providerActivity && !project.draft ? <>
          <section className="panel model-header">
            <div><h1>{project.title}</h1><p>A validated model will replace this activity view when generation completes.</p></div>
            <div className="header-actions"><span className="status-dot" aria-live="polite">{status}</span>
              {!providerActivity.active && <><button className="secondary-button" onClick={() => setProviderActivity(null)}>Edit inputs</button><button className="primary-button" disabled={!csvInputsConfirmed} onClick={() => void generate(generationJob?.id ?? null)}>Retry with current inputs</button></>}
            </div>
          </section>
          <ProviderActivityPanel activity={providerActivity}
            onCancel={generationJob?.status === 'queued' || generationJob?.status === 'running' ? () => void cancelGeneration() : undefined}
            onRetry={providerActivity.kind === 'generation' && !providerActivity.active && csvInputsConfirmed ? () => void generate(generationJob?.id ?? null) : undefined} />
        </> : !project || !project.draft ? <section className="panel intake-card">
          <div className="section-heading"><div><h2>{project ? 'Refine the intake before generation' : 'Start with what you know'}</h2><p>Incomplete requirements are expected. Save the model without contacting the configured provider, then generate when it is ready.</p></div><span className="status-dot" aria-live="polite">{status}</span></div>
          <fieldset className="intake-fields" disabled={busy}><legend className="sr-only">Model intake</legend>
          <label>Model name<input aria-label="Model name" value={intake.title} onChange={event => setIntake({ ...intake, title: event.target.value })} placeholder="e.g. Claim Payment" /></label>
          <label>Requirements<textarea aria-label="Requirements" value={intake.requirements} onChange={event => setIntake({ ...intake, requirements: event.target.value })} placeholder="Describe the entities, relationships, rules and questions…" rows={8} /></label>
          {project && <div className="provider-fields">
            <label>Provider<select aria-label="Project provider" disabled={generationLocked} value={project.providerSettings.providerType} onChange={event => void changeProjectProvider(event.target.value as ProviderType)}>
              {(Object.entries(providerLabels) as Array<[ProviderType, string]>).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select></label>
            <label>Model{projectModels.length
              ? <select aria-label="Project provider model" disabled={generationLocked} value={project.providerSettings.model} onChange={event => {
                setProject({ ...project, providerSettings: { ...project.providerSettings, model: event.target.value } });
                setProjectProviderDirty(true);
              }}>
                {!projectModels.some(model => model.id === project.providerSettings.model) && <option value={project.providerSettings.model}>{project.providerSettings.model}</option>}
                {projectModels.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
              : <input aria-label="Project provider model" disabled={generationLocked} value={project.providerSettings.model} onChange={event => {
                setProject({ ...project, providerSettings: { ...project.providerSettings, model: event.target.value } });
                setProjectProviderDirty(true);
              }} />}</label>
          </div>}
          <label className="file-drop"><span className="file-drop-title"><Icon name="plus" />Add source files</span><input aria-label="Source files" disabled={sourceUploadBusy} type="file" multiple accept=".md,.txt,.sql,.ddl,.json,.csv" onChange={event => void filesSelected(event.target.files)} />
            <span>Markdown, text, SQL, DDL, JSON or CSV · treated as inert data</span></label>
          {intake.sources.some(source => source.kind !== 'csv') && <ul className="source-list">{intake.sources.map((source, index) => source.kind !== 'csv' && <li key={source.clientId ?? `${source.name}-${index}`}><span className="source-name">{source.name}<small>{source.kind}</small></span><button className="icon-button destructive" aria-label={`Remove source ${source.name}`} onClick={() => setIntake(current => ({ ...current, sources: current.sources.filter((_, candidate) => candidate !== index) }))}><Icon name="trash" /></button></li>)}</ul>}
          {intake.sources.map((source, index) => source.kind === 'csv' && <CsvReview key={source.clientId ?? `csv-${source.name}-${index}`} source={source} disabled={busy || csvAnalysisPending.has(source.clientId ?? '')}
            onHeadersChange={headers => setIntake(current => ({ ...current, sources: current.sources.map((candidate, candidateIndex) =>
              candidateIndex === index && candidate.csvAnalysis
                ? { ...candidate, csvAnalysis: { ...candidate.csvAnalysis, headers, confirmed: false, confirmedAt: null } }
                : candidate) }))}
            onHeaderModeChange={mode => void analyseCsvSource(index, { headerMode: mode }, false)}
            onSensitiveChange={(columnIndex, sensitive) => {
              const columns = new Set(source.csvAnalysis?.additionalSensitiveColumns ?? []);
              if (sensitive) columns.add(columnIndex); else columns.delete(columnIndex);
              void analyseCsvSource(index, { additionalSensitiveColumns: [...columns] }, false);
            }}
            onConfirm={() => void analyseCsvSource(index, {}, true)}
            onReanalyse={() => void analyseCsvSource(index)}
            onRemove={() => setIntake(current => ({ ...current, sources: current.sources.filter((_, candidate) => candidate !== index) }))} />)}
          <div className="intake-actions">
            <button className="secondary-button" disabled={busy || !csvInputsAnalysed || !intake.title.trim() || !intake.requirements.trim()} onClick={() => void saveIntake()}>{project ? 'Save changes' : 'Save model'}</button>
            {project
              ? <button className="primary-button" disabled={busy || !csvInputsConfirmed || !intake.title.trim() || !intake.requirements.trim()} onClick={() => void generate(retryOriginId)}>
                {retryOriginId ? 'Retry with current inputs' : 'Generate draft'} <Icon name="arrow" />
              </button>
              : <button className="primary-button" disabled title="Save the model to review its provider and model before generation">Save before generation</button>}
            {project && <button className="danger-button" disabled={busy} onClick={() => void removeProject()}>Delete model</button>}
            <span>{project
              ? `Generate sends the current intake to ${providerLabels[project.providerSettings.providerType]} using ${project.providerSettings.model}.`
              : 'Save the model first to review and select the provider destination before generation.'}</span>
          </div>
          </fieldset>
        </section> : <>
          <section className="panel model-header">
            <div><h1>{project.draft.model.name} model</h1><p>{project.draft.model.businessDefinition}</p></div>
          </section>

          {providerActivity && <ProviderActivityPanel activity={providerActivity}
            onCancel={generationJob?.status === 'queued' || generationJob?.status === 'running' ? () => void cancelGeneration() : undefined}
            onRetry={providerActivity.kind === 'generation' && !providerActivity.active && csvInputsConfirmed ? () => void generate(generationJob?.id ?? null) : undefined} />}

          <div className="model-collaboration-grid">
            <button className={`chat-bubble${chatOpen ? ' open' : ''}`} ref={chatBubble} type="button" aria-label={chatOpen ? 'Close model assistant' : project.draft.clarificationQuestions[0] ? 'Open model assistant, one clarification available' : 'Open model assistant'} aria-expanded={chatOpen} aria-controls="model-assistant-panel" onClick={() => setChatOpen(open => !open)}>
              <Icon name={chatOpen ? 'close' : 'chat'} />
              {project.draft.clarificationQuestions[0] && !chatOpen && <span className="chat-bubble-badge" aria-hidden="true">1</span>}
            </button>
            <section className="panel preview-card" role="region" aria-label="Live model output">
              <h2 className="model-representations-title">Model representations</h2>
              <InteractiveModelCanvas key={preview} renderToolbar={controls => <div className="model-toolbar" role="toolbar" aria-label="Model representation controls">
                <div className="model-toolbar-controls">
                  <div className="segmented" aria-label="Preview format"><button aria-pressed={preview === 'mermaid'} className={preview === 'mermaid' ? 'active' : ''} onClick={() => setPreview('mermaid')}>Mermaid</button><button aria-pressed={preview === 'drawio'} className={preview === 'drawio' ? 'active' : ''} onClick={() => setPreview('drawio')}>draw.io</button></div>
                  <div className="canvas-controls">
                    <button className="canvas-control" type="button" aria-label="Zoom out" onClick={controls.zoomOut}><Icon name="minus" /></button>
                    <output aria-label="Zoom level" aria-live="polite">{Math.round(controls.scale * 100)}%</output>
                    <button className="canvas-control" type="button" aria-label="Zoom in" onClick={controls.zoomIn}><Icon name="plus" /></button>
                    <button className="canvas-reset" type="button" aria-label="Reset model view" onClick={controls.reset}><Icon name="reset" />Reset</button>
                  </div>
                  <div className="toolbar-group">
                    <button className="toolbar-button" type="button" aria-label="Copy Mermaid diagram image" disabled={Boolean(modelExportBusy) || !mermaidExportReady} onClick={() => void copyModelImage()}><Icon name="copy" />{modelExportBusy === 'copy' ? 'Copying…' : 'Copy'}</button>
                    <button className="toolbar-button" type="button" aria-label="Export Mermaid diagram and model details to PDF" disabled={Boolean(modelExportBusy) || !mermaidExportReady} onClick={() => void exportModel()}><Icon name="download" />{modelExportBusy === 'pdf' ? 'Exporting…' : 'Export PDF'}</button>
                  </div>
                  <div className="toolbar-group model-actions">
                    <button className="toolbar-button" disabled={busy || !csvInputsConfirmed} onClick={() => void generate()}>{generationInputsDirty ? 'Regenerate with changes' : 'Regenerate'}</button>
                    <button className="toolbar-button primary" disabled={busy} onClick={() => void saveVersion()}>Save version</button>
                    <button className="toolbar-button destructive" aria-label="Delete model" disabled={busy} onClick={() => void removeProject()}>Delete</button>
                  </div>
                  <span className="status-dot" aria-live="polite">{status}</span>
                </div>
              </div>}>
                {preview === 'mermaid' ? <MermaidPreview source={mermaid} /> : <DiagramPreview model={project.draft.model} />}
              </InteractiveModelCanvas>
              <div className="model-export-source" ref={modelExportSource} aria-hidden="true"><MermaidPreview source={mermaid} onRendered={setMermaidExportReady} /></div>
              <details className="json-details"><summary>Canonical JSON <span>Read only</span></summary><pre className="code-preview">{JSON.stringify(project.draft.model, null, 2)}</pre></details>
            </section>

            {chatOpen && <section className="panel assistant-card floating-chat-panel" id="model-assistant-panel" role="region" aria-label="Model chat">
              <div className="section-heading chat-panel-heading"><div><h2>Shape the model together</h2><p>Answer the next question or describe another change. Every successful reply updates the model.</p></div><button className="icon-button" type="button" aria-label="Close model assistant" onClick={() => setChatOpen(false)}><Icon name="close" /></button></div>
              <ol className="chat-transcript" ref={chatTranscript} aria-live="polite" aria-relevant="additions">
                {project.messages.map(item => <li className={`chat-message ${item.role}`} key={item.id}><span>{item.role === 'user' ? 'You' : 'Assistant'}</span><p className="chat-message-body">{item.content}</p></li>)}
                {project.draft.clarificationQuestions[0] ? <li className="chat-message assistant clarification-prompt"><span>Next clarification</span><p className="chat-message-body">{project.draft.clarificationQuestions[0]}</p></li>
                  : project.messages.length === 0 && <li className="chat-empty">No open questions. Try “Add recovery transactions and explain the relationship.”</li>}
                {pendingChatMessage && <>
                  <li className="chat-message user pending" key={pendingChatMessage.id}><span>You</span><p className="chat-message-body">{pendingChatMessage.content}</p></li>
                  <li className="chat-message assistant thinking" key={`${pendingChatMessage.id}-thinking`}><span>Assistant</span><p className="chat-message-body thinking-copy"><span className="thinking-status">{providerActivity?.message ?? 'Thinking...'}</span><span className="thinking-visible" aria-hidden="true">{providerActivity?.message ?? 'Thinking'}<span className="thinking-dots"><i /><i /><i /></span></span></p></li>
                </>}
              </ol>
              <label>{project.draft.clarificationQuestions[0] ? 'Answer or request a change' : 'Message'}<textarea aria-label="Message the model assistant" value={chatMessage} maxLength={4000} rows={3} onChange={event => setChatMessage(event.target.value)} placeholder={project.draft.clarificationQuestions[0] ? 'Answer the question or describe another change…' : 'Describe the change you want…'} /></label>
              <div className="chat-actions"><small>Your message, persistent instructions, current model and source context are sent to the configured provider.</small><button className="primary-button" disabled={busy || !csvInputsConfirmed || Boolean(pendingChatMessage) || !chatMessage.trim()} onClick={() => void sendChatMessage()}>Send message <Icon name="arrow" /></button></div>
            </section>}
          </div>

          <section className="panel editor-card" role="region" aria-label="Structured model editor">
            <div className="section-heading"><div><h2>Structured editor</h2><p>Edit the source of truth. Changes autosave to this working draft.</p></div><span className="count-badge">{project.draft.model.entities.length} entities · {project.draft.model.relationships.length} relationships</span></div>
            <fieldset className="structured-editor-fields" disabled={busy}>
              <legend className="sr-only">Structured model fields</legend>
            <details className="generation-inputs" open>
              <summary><div><h3>Requirements, attachments and provider</h3><p>Edit the exact inputs used by the next regeneration or assistant turn.</p></div><Icon name="chevron" /></summary>
              <div className="generation-inputs-body">
                <div className="provider-fields">
                  <label>Provider<select aria-label="Project provider" value={project.providerSettings.providerType} onChange={event => void changeProjectProvider(event.target.value as ProviderType)}>
                    {(Object.entries(providerLabels) as Array<[ProviderType, string]>).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                  </select></label>
                  <label>Model{projectModels.length
                    ? <select aria-label="Project provider model" value={project.providerSettings.model} onChange={event => {
                      setProject({ ...project, providerSettings: { ...project.providerSettings, model: event.target.value } });
                      setProjectProviderDirty(true);
                    }}>
                      {!projectModels.some(model => model.id === project.providerSettings.model) && <option value={project.providerSettings.model}>{project.providerSettings.model}</option>}
                      {projectModels.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
                    </select>
                    : <input aria-label="Project provider model" value={project.providerSettings.model} onChange={event => {
                      setProject({ ...project, providerSettings: { ...project.providerSettings, model: event.target.value } });
                      setProjectProviderDirty(true);
                    }} />}</label>
                  {project.providerSettings.providerType === 'openai' && <label>Base URL<input aria-label="Project provider base URL" disabled={generationLocked} type="url" value={project.providerSettings.baseUrl} onChange={event => {
                    setProject({ ...project, providerSettings: { ...project.providerSettings, baseUrl: event.target.value } });
                    setProjectProviderDirty(true);
                  }} /></label>}
                </div>
                <label>Persistent model requirements<textarea aria-label="Persistent model instructions" disabled={generationLocked} value={intake.requirements} maxLength={20_000} rows={7} onChange={event => setIntake({ ...intake, requirements: event.target.value })} /></label>
                <div className="attachment-heading"><div><strong>Source attachments</strong><span>CSV samples are sent unchanged unless you mark columns sensitive.</span></div>
                  <label className="compact-file-button">Add files<input aria-label="Add generation source files" disabled={generationLocked || sourceUploadBusy} type="file" multiple accept=".md,.txt,.sql,.ddl,.json,.csv" onChange={event => void filesSelected(event.target.files)} /></label>
                </div>
                <div className="attachment-editors">{intake.sources.length ? intake.sources.map((source, index) => source.kind === 'csv'
                  ? <CsvReview key={source.clientId ?? `${source.name}-${index}`} source={source} disabled={generationLocked || csvAnalysisPending.has(source.clientId ?? '')}
                    onHeadersChange={headers => setIntake(current => ({ ...current, sources: current.sources.map((candidate, candidateIndex) =>
                      candidateIndex === index && candidate.csvAnalysis
                        ? { ...candidate, csvAnalysis: { ...candidate.csvAnalysis, headers, confirmed: false, confirmedAt: null } }
                        : candidate) }))}
                    onHeaderModeChange={mode => void analyseCsvSource(index, { headerMode: mode }, false)}
                    onSensitiveChange={(columnIndex, sensitive) => {
                      const columns = new Set(source.csvAnalysis?.additionalSensitiveColumns ?? []);
                      if (sensitive) columns.add(columnIndex); else columns.delete(columnIndex);
                      void analyseCsvSource(index, { additionalSensitiveColumns: [...columns] }, false);
                    }}
                    onConfirm={() => void analyseCsvSource(index, {}, true)}
                    onReanalyse={() => void analyseCsvSource(index)}
                    onContentChange={content => setIntake(current => ({
                      ...current,
                      sources: current.sources.map((item, candidate) => candidate === index
                        ? {
                          ...item,
                          content,
                          csvAnalysis: item.csvAnalysis
                            ? { ...item.csvAnalysis, contentDigest: '', confirmed: false, confirmedAt: null }
                            : null,
                        }
                        : item),
                    }))}
                    onRemove={() => setIntake(current => ({ ...current, sources: current.sources.filter((_, candidate) => candidate !== index) }))} />
                  : <article className="attachment-editor" key={`${source.name}-${index}`}>
                    <div><strong>{source.name}</strong><span>{source.kind}</span><button className="icon-button destructive" disabled={generationLocked} type="button" aria-label={`Remove source ${source.name}`} onClick={() => setIntake(current => ({
                      ...current, sources: current.sources.filter((_, candidate) => candidate !== index),
                    }))}><Icon name="trash" /></button></div>
                    <textarea aria-label={`Source content ${source.name}`} disabled={generationLocked} value={source.content} rows={8} onChange={event => setIntake(current => ({
                      ...current,
                      sources: current.sources.map((item, candidate) => candidate === index ? { ...item, content: event.target.value } : item),
                    }))} />
                  </article>) : <p className="empty-copy">No source attachments. Requirements alone will be sent.</p>}</div>
                <div className="model-instructions-actions"><p>Saving these inputs makes no provider call. Every new job snapshots them for audit and retry.</p><button className="secondary-button" disabled={busy || !csvInputsAnalysed || !generationInputsDirty || !intake.requirements.trim()} onClick={() => void saveGenerationInputs()}>{generationInputsDirty ? 'Save generation inputs' : 'Generation inputs saved'}</button></div>
              </div>
            </details>
            <div className="model-fields">
              <label>Model name<input aria-label="Canonical model name" value={project.draft.model.name} onChange={event => updateModel(model => { model.name = event.target.value; })} /></label>
              <label>Business definition<textarea aria-label="Canonical model business definition" value={project.draft.model.businessDefinition} onChange={event => updateModel(model => { model.businessDefinition = event.target.value; })} rows={2} /></label>
            </div>
            <details className="entities-editor editor-disclosure"><summary><div className="editor-group-heading"><h3>Entities</h3><p>Review entity definitions, attributes, keys and references.</p></div><span className="count-badge">{project.draft.model.entities.length}</span><Icon name="chevron" /></summary><div className="editor-disclosure-body">
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
            }}><Icon name="plus" />Add entity</button>
            </div></details>

            <details className="relationship-editor editor-disclosure"><summary><div className="editor-group-heading"><h3>Relationships</h3><p>Connect entities and make cardinality explicit.</p></div><span className="count-badge">{project.draft.model.relationships.length}</span><Icon name="chevron" /></summary><div className="editor-disclosure-body"><div className="relationship-labels"><span>Name</span><span>From</span><span>Cardinality</span><span /><span>To</span><span>Cardinality</span><span /></div>{project.draft.model.relationships.map((relationship, index) => <div className="relationship-row" key={relationship.id}>
              <input aria-label={`Relationship ${index + 1} name`} value={relationship.name} onChange={event => updateModel(model => { model.relationships[index].name = event.target.value; })} />
              <select aria-label={`Relationship ${index + 1} source`} value={relationship.fromEntityId} onChange={event => updateModel(model => { model.relationships[index].fromEntityId = event.target.value; })}>{project.draft!.model.entities.map(entity => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select>
              <select aria-label={`Relationship ${index + 1} source cardinality`} value={relationship.fromCardinality} onChange={event => updateModel(model => { model.relationships[index].fromCardinality = event.target.value as typeof relationship.fromCardinality; })}><option value="one">one</option><option value="zero-or-one">zero or one</option><option value="one-or-many">one or many</option><option value="zero-or-many">zero or many</option></select>
              <span>to</span>
              <select aria-label={`Relationship ${index + 1} target`} value={relationship.toEntityId} onChange={event => updateModel(model => { model.relationships[index].toEntityId = event.target.value; })}>{project.draft!.model.entities.map(entity => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select>
              <select aria-label={`Relationship ${index + 1} target cardinality`} value={relationship.toCardinality} onChange={event => updateModel(model => { model.relationships[index].toCardinality = event.target.value as typeof relationship.toCardinality; })}><option value="one">one</option><option value="zero-or-one">zero or one</option><option value="one-or-many">one or many</option><option value="zero-or-many">zero or many</option></select>
              <button className="icon-button destructive" aria-label={`Remove relationship ${relationship.name}`} onClick={() => updateModel(model => { model.relationships.splice(index, 1); })}><Icon name="trash" /></button>
            </div>)}<button className="text-button editor-add" onClick={() => updateModel(model => model.relationships.push({ id: crypto.randomUUID(), name: `relationship_${model.relationships.length + 1}`, fromEntityId: model.entities[0].id, toEntityId: model.entities[1]?.id ?? model.entities[0].id, fromCardinality: 'one', toCardinality: 'zero-or-many' }))}><Icon name="plus" />Add relationship</button></div></details>

            <details className="rule-editor editor-disclosure"><summary><div className="editor-group-heading"><h3>Validation rules</h3><p>Keep business constraints beside the model they protect.</p></div><span className="count-badge">{project.draft.model.rules.length}</span><Icon name="chevron" /></summary><div className="editor-disclosure-body">{project.draft.model.rules.map((rule, index) => <article className="rule-row" key={rule.id}>
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
            </article>)}<button className="text-button editor-add" onClick={() => updateModel(model => model.rules.push({ id: crypto.randomUUID(), name: `Rule ${model.rules.length + 1}`, expression: 'Define expression', businessDefinition: 'Define this validation rule.', entityIds: [model.entities[0].id] }))}><Icon name="plus" />Add validation rule</button></div></details>
            </fieldset>
          </section>

          <details className="panel history-card editor-disclosure"><summary><div><h2>Version history</h2><p>Freeze reviewed milestones and reopen an earlier version as a new working draft.</p></div><span className="count-badge">{project.versions.length}</span><Icon name="chevron" /></summary><div className="history-body">{latest && <div className="download-actions"><a download={`${downloadStem}-v${latest}.mmd`} href={`/api/projects/${project.id}/downloads/mermaid?version=${latest}`}>Download Mermaid v{latest}</a><a download={`${downloadStem}-v${latest}.drawio`} href={`/api/projects/${project.id}/downloads/drawio?version=${latest}`}>Download draw.io v{latest}</a></div>}
            {project.versions.length ? <ol className="version-list">{project.versions.map(version => <li key={version.id}><div><strong>Version {version.versionNumber}</strong><span>{new Date(version.createdAt).toLocaleString()}</span></div><button className="text-button" disabled={busy} onClick={() => void continueVersion(version.versionNumber)}>Open as draft</button></li>)}</ol> : <p className="empty-copy">Save the reviewed draft to create version 1.</p>}
          </div></details>

          <section className="review-grid bottom-review" role="region" aria-label="Assumptions and warnings">
            <details className="panel review-card assumptions-card editor-disclosure"><summary><div><h3>Assumptions</h3><p>Review facts inferred while building the model.</p></div><span className="count-badge">{project.draft.assumptions.length}</span><Icon name="chevron" /></summary><div className="review-body">{project.draft.assumptions.length ? <ul>{project.draft.assumptions.map(item => <li key={item}>{item}</li>)}</ul> : <p>No assumptions recorded.</p>}</div></details>
            <details className="panel review-card warning warnings-card editor-disclosure"><summary><div><h3>Warnings</h3><p>Check unresolved risks before saving a version.</p></div><span className="count-badge">{project.draft.warnings.length}</span><Icon name="chevron" /></summary><div className="review-body">{project.draft.warnings.length ? <ul>{project.draft.warnings.map(item => <li key={item}>{item}</li>)}</ul> : <p>No warnings.</p>}</div></details>
          </section>
        </>}
      </section>
    </div>
  </main>;
}
