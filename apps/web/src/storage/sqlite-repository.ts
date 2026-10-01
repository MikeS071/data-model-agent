import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseGenerationResult, validateCanonicalModel } from '@/domain/model';
import type { CanonicalModel, GenerationResult, SourceArtifact, SourceArtifactInput } from '@/domain/model';
import { normalizeProviderBaseUrl, parseProviderSettings } from '@/domain/provider-settings';
import { parseProviderSelection } from '@/domain/provider-settings';
import { parseStoredProviderSelection } from '@/domain/provider-settings';
import type { ProviderSelection, ProviderSettings, ProviderType } from '@/domain/provider-settings';
import { renderDrawio } from '@/render/drawio';
import { renderMermaid } from '@/render/mermaid';

export interface ProjectRecord {
  id: string;
  title: string;
  requirements: string;
  createdAt: string;
  updatedAt: string;
  sources: SourceArtifact[];
  draft: GenerationResult | null;
  versions: VersionSummary[];
  messages: ChatMessage[];
  providerSettings: ProviderSelection | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  versionCount: number;
  hasDraft: boolean;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  createdAt: string;
}

export interface ModelVersion extends VersionSummary, GenerationResult {
  projectId: string;
  sources: SourceArtifact[];
  mermaid: string;
  drawio: string;
}

interface ProjectRow { id: string; title: string; requirements: string; created_at: string; updated_at: string }
interface SourceRow { id: string; name: string; kind: SourceArtifact['kind']; content: string; ordinal: number }
interface DraftRow { model_json: string; assumptions_json: string; warnings_json: string; questions_json: string }
interface MessageRow { id: string; role: ChatMessage['role']; content: string; created_at: string }
interface VersionRow extends DraftRow { id: string; project_id: string; version_number: number; sources_json: string; mermaid: string; drawio: string; created_at: string }
interface ProviderSettingsRow { base_url: string; model: string }
interface ProjectProviderSettingsRow extends ProviderSettingsRow { provider_type: ProviderType }
interface GenerationJobRow {
  id: string; project_id: string; status: GenerationJobStatus; provider_type: ProviderType; base_url: string; model: string;
  request_json: string; phase: string; message: string; transcript: string; error_code: string | null;
  created_at: string; started_at: string | null; heartbeat_at: string | null; completed_at: string | null; updated_at: string;
}

export type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export interface GenerationJobRequest {
  requirements: string;
  sources: SourceArtifactInput[];
  currentModel: CanonicalModel | null;
  clarification: string | null;
}

export interface GenerationJobRecord {
  id: string;
  projectId: string;
  status: GenerationJobStatus;
  providerSettings: ProviderSelection;
  request: GenerationJobRequest;
  phase: string;
  message: string;
  transcript: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

const now = () => new Date().toISOString();
const GENERATION_STALE_AFTER_MS = 60_000;
const decodeGeneration = (row: DraftRow): GenerationResult => parseGenerationResult({
  model: JSON.parse(row.model_json), assumptions: JSON.parse(row.assumptions_json),
  warnings: JSON.parse(row.warnings_json), clarificationQuestions: JSON.parse(row.questions_json),
});

export class SqliteModelRepository {
  readonly #database: DatabaseSync;
  readonly #nowMs: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.#nowMs = options.now ?? Date.now;
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, requirements TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_artifacts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ordinal INTEGER NOT NULL,
        UNIQUE(project_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS working_drafts (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        model_json TEXT NOT NULL, assumptions_json TEXT NOT NULL, warnings_json TEXT NOT NULL,
        questions_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        ordinal INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS model_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL, model_json TEXT NOT NULL, assumptions_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL, questions_json TEXT NOT NULL, sources_json TEXT NOT NULL,
        mermaid TEXT NOT NULL, drawio TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project_id, version_number)
      );
      CREATE TABLE IF NOT EXISTS provider_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), base_url TEXT NOT NULL,
        model TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_settings_by_type (
        provider_type TEXT PRIMARY KEY CHECK(provider_type IN ('openai','copilot-sdk')),
        base_url TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_settings_v2 (
        provider_type TEXT PRIMARY KEY, base_url TEXT NOT NULL,
        model TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO provider_settings_by_type(provider_type,base_url,model,updated_at)
        SELECT 'openai',base_url,model,updated_at FROM provider_settings WHERE singleton=1;
      INSERT OR IGNORE INTO provider_settings_v2(provider_type,base_url,model,updated_at)
        SELECT provider_type,base_url,model,updated_at FROM provider_settings_by_type;
      CREATE TABLE IF NOT EXISTS application_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        default_provider_type TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_provider_settings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        provider_type TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted','cancelled')),
        provider_type TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, request_json TEXT NOT NULL,
        phase TEXT NOT NULL, message TEXT NOT NULL, transcript TEXT NOT NULL DEFAULT '', error_code TEXT,
        created_at TEXT NOT NULL, started_at TEXT, heartbeat_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS generation_jobs_project_created ON generation_jobs(project_id,created_at DESC);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (6);
    `);
    const timestamp = now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`UPDATE generation_jobs SET status='interrupted',phase='interrupted',
        message='A newer generation replaced this duplicate active job.',error_code='generation-interrupted',
        completed_at=?,updated_at=? WHERE id IN (
          SELECT id FROM (
            SELECT id,ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC,id DESC) AS active_position
            FROM generation_jobs WHERE status IN ('queued','running')
          ) WHERE active_position > 1
        )`).run(timestamp, timestamp);
      this.#database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_one_active_per_project
        ON generation_jobs(project_id) WHERE status IN ('queued','running')`);
      this.#database.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (7)').run();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #interruptStaleGenerationJobs(projectId?: string) {
    const timestamp = now();
    const staleBefore = new Date(this.#nowMs() - GENERATION_STALE_AFTER_MS).toISOString();
    const projectFilter = projectId ? ' AND project_id=?' : '';
    const parameters = projectId
      ? [timestamp, timestamp, staleBefore, projectId]
      : [timestamp, timestamp, staleBefore];
    return this.#database.prepare(`UPDATE generation_jobs SET status='interrupted',phase='interrupted',
      message='Generation stopped sending heartbeats and can be retried.',error_code='generation-interrupted',
      completed_at=?,updated_at=? WHERE status IN ('queued','running')
      AND COALESCE(heartbeat_at,created_at) < ?${projectFilter}`).run(...parameters).changes;
  }

  getDefaultProviderType(fallback: ProviderType): ProviderType {
    const row = this.#database.prepare('SELECT default_provider_type FROM application_settings WHERE singleton=1')
      .get() as { default_provider_type: ProviderType } | undefined;
    return row?.default_provider_type ?? fallback;
  }

  saveDefaultProvider(selection: ProviderSelection): ProviderSelection {
    const value = parseProviderSelection(selection), timestamp = now();
    this.saveProviderSettings(value, value.providerType);
    this.#database.prepare(`INSERT INTO application_settings(singleton,default_provider_type,updated_at) VALUES (1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET default_provider_type=excluded.default_provider_type,updated_at=excluded.updated_at`)
      .run(value.providerType, timestamp);
    return value;
  }

  getProviderSettings(fallback: ProviderSettings, providerType: ProviderType = 'openai'): ProviderSettings {
    const row = this.#database.prepare('SELECT base_url,model FROM provider_settings_v2 WHERE provider_type=?')
      .get(providerType) as ProviderSettingsRow | undefined;
    return row ? parseProviderSettings({ baseUrl: row.base_url, model: row.model }) : {
      baseUrl: normalizeProviderBaseUrl(fallback.baseUrl), model: fallback.model.trim(),
    };
  }

  saveProviderSettings(input: ProviderSettings, providerType: ProviderType = 'openai'): ProviderSettings {
    const value = parseProviderSettings(input);
    this.#database.prepare(`INSERT INTO provider_settings_v2(provider_type,base_url,model,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(provider_type) DO UPDATE SET base_url=excluded.base_url, model=excluded.model, updated_at=excluded.updated_at`)
      .run(providerType, value.baseUrl, value.model, now());
    return value;
  }

  createProject(input: { title: string; requirements: string; sources: SourceArtifactInput[]; providerSettings?: ProviderSelection }): ProjectRecord {
    const id = randomUUID(), timestamp = now();
    if (!input.title.trim() || !input.requirements.trim()) throw new Error('project-input-invalid');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare('INSERT INTO projects(id,title,requirements,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(id, input.title.trim(), input.requirements, timestamp, timestamp);
      const insert = this.#database.prepare('INSERT INTO source_artifacts(id,project_id,name,kind,content,ordinal) VALUES (?,?,?,?,?,?)');
      input.sources.forEach((source, ordinal) => insert.run(randomUUID(), id, source.name, source.kind, source.content, ordinal));
      if (input.providerSettings) {
        const provider = parseStoredProviderSelection(input.providerSettings);
        this.#database.prepare('INSERT INTO project_provider_settings(project_id,provider_type,base_url,model,updated_at) VALUES (?,?,?,?,?)')
          .run(id, provider.providerType, provider.baseUrl, provider.model, timestamp);
      }
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
    return this.getProject(id)!;
  }

  updateProject(id: string, input: { title: string; requirements: string; sources: SourceArtifactInput[]; providerSettings?: ProviderSelection }): ProjectRecord {
    const title = input.title.trim(), requirements = input.requirements.trim(), timestamp = now();
    if (!title || !requirements) throw new Error('project-input-invalid');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare('UPDATE projects SET title=?,requirements=?,updated_at=? WHERE id=?')
        .run(title, requirements, timestamp, id);
      if (result.changes !== 1) throw new Error('project-missing');
      this.#database.prepare('DELETE FROM source_artifacts WHERE project_id=?').run(id);
      const insert = this.#database.prepare('INSERT INTO source_artifacts(id,project_id,name,kind,content,ordinal) VALUES (?,?,?,?,?,?)');
      input.sources.forEach((source, ordinal) => insert.run(randomUUID(), id, source.name, source.kind, source.content, ordinal));
      if (input.providerSettings) {
        const provider = parseStoredProviderSelection(input.providerSettings);
        this.#database.prepare(`INSERT INTO project_provider_settings(project_id,provider_type,base_url,model,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(project_id) DO UPDATE SET provider_type=excluded.provider_type,base_url=excluded.base_url,
          model=excluded.model,updated_at=excluded.updated_at`)
          .run(id, provider.providerType, provider.baseUrl, provider.model, timestamp);
      }
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
    return this.getProject(id)!;
  }

  deleteProject(id: string): boolean {
    return this.#database.prepare('DELETE FROM projects WHERE id=?').run(id).changes === 1;
  }

  saveProjectProviderSettings(projectId: string, input: ProviderSelection): ProviderSelection {
    const value = parseStoredProviderSelection(input), timestamp = now();
    const result = this.#database.prepare(`INSERT INTO project_provider_settings(project_id,provider_type,base_url,model,updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projects WHERE id=?)
      ON CONFLICT(project_id) DO UPDATE SET provider_type=excluded.provider_type,base_url=excluded.base_url,
      model=excluded.model,updated_at=excluded.updated_at`)
      .run(projectId, value.providerType, value.baseUrl, value.model, timestamp, projectId);
    if (result.changes !== 1) throw new Error('project-missing');
    return value;
  }

  createGenerationJob(projectId: string, providerSettings: ProviderSelection, request: GenerationJobRequest): GenerationJobRecord {
    const provider = parseProviderSelection(providerSettings);
    const timestamp = now();
    const id = randomUUID();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.#database.prepare('SELECT 1 AS value FROM projects WHERE id=?').get(projectId)) throw new Error('project-missing');
      this.#interruptStaleGenerationJobs(projectId);
      if (this.#database.prepare(`SELECT 1 AS value FROM generation_jobs WHERE project_id=? AND status IN ('queued','running')`).get(projectId)) {
        throw new Error('generation-in-progress');
      }
      this.#database.prepare(`INSERT INTO generation_jobs(id,project_id,status,provider_type,base_url,model,request_json,phase,message,transcript,
        error_code,created_at,started_at,heartbeat_at,completed_at,updated_at) VALUES (?,?, 'queued',?,?,?,?,'queued','Generation queued.','',NULL,?,NULL,?,NULL,?)`)
        .run(id, projectId, provider.providerType, provider.baseUrl, provider.model, JSON.stringify(request), timestamp, timestamp, timestamp);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.getGenerationJob(id)!;
  }

  claimGenerationJob(id: string): GenerationJobRecord {
    const timestamp = now();
    const result = this.#database.prepare(`UPDATE generation_jobs SET status='running',phase='connecting',
      message='Connecting to the configured provider…',started_at=?,heartbeat_at=?,updated_at=? WHERE id=? AND status='queued'`)
      .run(timestamp, timestamp, timestamp, id);
    if (result.changes !== 1) throw new Error('generation-job-unavailable');
    return this.getGenerationJob(id)!;
  }

  updateGenerationJobProgress(id: string, phase: string, message: string, transcriptDelta = ''): GenerationJobRecord {
    const timestamp = now();
    const result = this.#database.prepare(`UPDATE generation_jobs SET phase=?,message=?,
      transcript=CASE WHEN ?='' THEN transcript ELSE substr(transcript || ?, -100000) END,
      heartbeat_at=?,updated_at=? WHERE id=? AND status='running'`)
      .run(phase, message, transcriptDelta, transcriptDelta, timestamp, timestamp, id);
    if (result.changes !== 1) throw new Error('generation-job-unavailable');
    return this.getGenerationJob(id)!;
  }

  heartbeatGenerationJob(id: string): boolean {
    const timestamp = now();
    return this.#database.prepare('UPDATE generation_jobs SET heartbeat_at=?,updated_at=? WHERE id=? AND status=?')
      .run(timestamp, timestamp, id, 'running').changes === 1;
  }

  completeGenerationJob(id: string, draft: GenerationResult): GenerationJobRecord {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as GenerationJobRow | undefined;
      if (!row || row.status !== 'running') throw new Error('generation-job-unavailable');
      const job = this.#generationJob(row);
      this.saveWorkingDraft(job.projectId, draft);
      const timestamp = now();
      const result = this.#database.prepare(`UPDATE generation_jobs SET status='completed',phase='completed',message='Draft ready.',
        heartbeat_at=?,completed_at=?,updated_at=? WHERE id=? AND status='running'`).run(timestamp, timestamp, timestamp, id);
      if (result.changes !== 1) throw new Error('generation-job-unavailable');
      this.#database.exec('COMMIT');
      return this.getGenerationJob(id)!;
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }

  failGenerationJob(id: string, errorCode: string, message: string, status: 'failed' | 'interrupted' = 'failed'): GenerationJobRecord {
    const timestamp = now();
    const result = this.#database.prepare(`UPDATE generation_jobs SET status=?,phase=?,message=?,error_code=?,
      heartbeat_at=?,completed_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')`)
      .run(status, status, message, errorCode, timestamp, timestamp, timestamp, id);
    if (result.changes !== 1) throw new Error('generation-job-unavailable');
    return this.getGenerationJob(id)!;
  }

  cancelGenerationJob(id: string): GenerationJobRecord {
    const timestamp = now();
    const result = this.#database.prepare(`UPDATE generation_jobs SET status='cancelled',phase='cancelled',
      message='Generation cancelled.',error_code='generation-cancelled',completed_at=?,updated_at=?
      WHERE id=? AND status IN ('queued','running')`).run(timestamp, timestamp, id);
    if (result.changes !== 1) throw new Error('generation-job-unavailable');
    return this.getGenerationJob(id)!;
  }

  getGenerationJob(id: string): GenerationJobRecord | null {
    this.#interruptStaleGenerationJobs();
    const row = this.#database.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as GenerationJobRow | undefined;
    return row ? this.#generationJob(row) : null;
  }

  getLatestGenerationJob(projectId: string): GenerationJobRecord | null {
    this.#interruptStaleGenerationJobs(projectId);
    const row = this.#database.prepare('SELECT * FROM generation_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 1')
      .get(projectId) as GenerationJobRow | undefined;
    return row ? this.#generationJob(row) : null;
  }

  saveWorkingDraft(projectId: string, draft: GenerationResult): GenerationResult {
    const value = parseGenerationResult(draft), timestamp = now();
    const result = this.#database.prepare(`INSERT INTO working_drafts(project_id,model_json,assumptions_json,warnings_json,questions_json,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET model_json=excluded.model_json, assumptions_json=excluded.assumptions_json,
      warnings_json=excluded.warnings_json, questions_json=excluded.questions_json, updated_at=excluded.updated_at`)
      .run(projectId, JSON.stringify(value.model), JSON.stringify(value.assumptions), JSON.stringify(value.warnings), JSON.stringify(value.clarificationQuestions), timestamp);
    if (result.changes !== 1) throw new Error('project-missing');
    this.#database.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(timestamp, projectId);
    return value;
  }

  saveChatTurn(projectId: string, userMessage: string, assistantMessage: string, draft: GenerationResult): ProjectRecord {
    const value = parseGenerationResult(draft), user = userMessage.trim(), assistant = assistantMessage.trim(), timestamp = now();
    if (!user || !assistant) throw new Error('chat-message-invalid');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.#database.prepare('SELECT 1 AS value FROM projects WHERE id=?').get(projectId)) throw new Error('project-missing');
      const ordinal = (this.#database.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS value FROM model_messages WHERE project_id=?').get(projectId) as { value: number }).value;
      const insertMessage = this.#database.prepare('INSERT INTO model_messages(id,project_id,role,content,ordinal,created_at) VALUES (?,?,?,?,?,?)');
      insertMessage.run(randomUUID(), projectId, 'user', user, ordinal, timestamp);
      insertMessage.run(randomUUID(), projectId, 'assistant', assistant, ordinal + 1, timestamp);
      this.#database.prepare(`INSERT INTO working_drafts(project_id,model_json,assumptions_json,warnings_json,questions_json,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET model_json=excluded.model_json, assumptions_json=excluded.assumptions_json,
        warnings_json=excluded.warnings_json, questions_json=excluded.questions_json, updated_at=excluded.updated_at`)
        .run(projectId, JSON.stringify(value.model), JSON.stringify(value.assumptions), JSON.stringify(value.warnings), JSON.stringify(value.clarificationQuestions), timestamp);
      this.#database.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(timestamp, projectId);
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
    return this.getProject(projectId)!;
  }

  saveVersion(projectId: string): ModelVersion {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const project = this.getProject(projectId);
      if (!project?.draft) throw new Error('draft-missing');
      const version = (this.#database.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS value FROM model_versions WHERE project_id=?').get(projectId) as { value: number }).value;
      const id = randomUUID(), timestamp = now(), mermaid = renderMermaid(project.draft.model), drawio = renderDrawio(project.draft.model);
      this.#database.prepare(`INSERT INTO model_versions(id,project_id,version_number,model_json,assumptions_json,warnings_json,questions_json,sources_json,mermaid,drawio,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, version, JSON.stringify(project.draft.model), JSON.stringify(project.draft.assumptions),
        JSON.stringify(project.draft.warnings), JSON.stringify(project.draft.clarificationQuestions), JSON.stringify(project.sources), mermaid, drawio, timestamp);
      this.#database.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(timestamp, projectId);
      this.#database.exec('COMMIT');
      return this.getVersion(projectId, version)!;
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }

  continueFromVersion(projectId: string, versionNumber: number): GenerationResult {
    const version = this.getVersion(projectId, versionNumber);
    if (!version) throw new Error('version-missing');
    return this.saveWorkingDraft(projectId, version);
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.#database.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow | undefined;
    if (!row) return null;
    const sources = (this.#database.prepare('SELECT id,name,kind,content,ordinal FROM source_artifacts WHERE project_id=? ORDER BY ordinal').all(id) as unknown as SourceRow[])
      .map(source => ({ id: source.id, name: source.name, kind: source.kind, content: source.content, ordinal: source.ordinal }));
    const draftRow = this.#database.prepare('SELECT model_json,assumptions_json,warnings_json,questions_json FROM working_drafts WHERE project_id=?').get(id) as DraftRow | undefined;
    const versions = (this.#database.prepare('SELECT id,version_number,created_at FROM model_versions WHERE project_id=? ORDER BY version_number DESC').all(id) as unknown as Array<{ id: string; version_number: number; created_at: string }>)
      .map(version => ({ id: version.id, versionNumber: version.version_number, createdAt: version.created_at }));
    const messages = (this.#database.prepare('SELECT id,role,content,created_at FROM model_messages WHERE project_id=? ORDER BY ordinal').all(id) as unknown as MessageRow[])
      .map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: message.created_at }));
    const providerRow = this.#database.prepare('SELECT provider_type,base_url,model FROM project_provider_settings WHERE project_id=?')
      .get(id) as ProjectProviderSettingsRow | undefined;
    const providerSettings = providerRow ? parseStoredProviderSelection({
      providerType: providerRow.provider_type, baseUrl: providerRow.base_url, model: providerRow.model,
    }) : null;
    return { id: row.id, title: row.title, requirements: row.requirements, createdAt: row.created_at, updatedAt: row.updated_at, sources, draft: draftRow ? decodeGeneration(draftRow) : null, versions, messages, providerSettings };
  }

  getVersion(projectId: string, versionNumber: number): ModelVersion | null {
    const row = this.#database.prepare('SELECT * FROM model_versions WHERE project_id=? AND version_number=?').get(projectId, versionNumber) as VersionRow | undefined;
    if (!row) return null;
    const generation = decodeGeneration(row);
    return { id: row.id, projectId: row.project_id, versionNumber: row.version_number, createdAt: row.created_at,
      ...generation, sources: JSON.parse(row.sources_json) as SourceArtifact[], mermaid: row.mermaid, drawio: row.drawio };
  }

  listProjects(): ProjectSummary[] {
    const rows = this.#database.prepare(`SELECT p.id,p.title,p.updated_at,COUNT(v.id) AS version_count,
      CASE WHEN d.project_id IS NULL THEN 0 ELSE 1 END AS has_draft FROM projects p
      LEFT JOIN model_versions v ON v.project_id=p.id LEFT JOIN working_drafts d ON d.project_id=p.id
      GROUP BY p.id,p.title,p.updated_at,d.project_id ORDER BY p.updated_at DESC`).all() as unknown as Array<{ id: string; title: string; updated_at: string; version_count: number; has_draft: number }>;
    return rows.map(row => ({ id: row.id, title: row.title, updatedAt: row.updated_at, versionCount: Number(row.version_count), hasDraft: row.has_draft === 1 }));
  }

  validateDraft(model: unknown): CanonicalModel { return validateCanonicalModel(model); }
  #generationJob(row: GenerationJobRow): GenerationJobRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      providerSettings: parseProviderSelection({ providerType: row.provider_type, baseUrl: row.base_url, model: row.model }),
      request: JSON.parse(row.request_json) as GenerationJobRequest,
      phase: row.phase,
      message: row.message,
      transcript: row.transcript,
      error: row.error_code,
      createdAt: row.created_at,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    };
  }
  close() { this.#database.close(); }
}
