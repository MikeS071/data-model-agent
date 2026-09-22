import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseGenerationResult, validateCanonicalModel } from '@/domain/model';
import type { CanonicalModel, GenerationResult, SourceArtifact, SourceArtifactInput } from '@/domain/model';
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

const now = () => new Date().toISOString();
const decodeGeneration = (row: DraftRow): GenerationResult => parseGenerationResult({
  model: JSON.parse(row.model_json), assumptions: JSON.parse(row.assumptions_json),
  warnings: JSON.parse(row.warnings_json), clarificationQuestions: JSON.parse(row.questions_json),
});

export class SqliteModelRepository {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
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
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
    `);
  }

  createProject(input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
    const id = randomUUID(), timestamp = now();
    if (!input.title.trim() || !input.requirements.trim()) throw new Error('project-input-invalid');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare('INSERT INTO projects(id,title,requirements,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(id, input.title.trim(), input.requirements, timestamp, timestamp);
      const insert = this.#database.prepare('INSERT INTO source_artifacts(id,project_id,name,kind,content,ordinal) VALUES (?,?,?,?,?,?)');
      input.sources.forEach((source, ordinal) => insert.run(randomUUID(), id, source.name, source.kind, source.content, ordinal));
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
    return this.getProject(id)!;
  }

  updateProject(id: string, input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
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
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
    return this.getProject(id)!;
  }

  deleteProject(id: string): boolean {
    return this.#database.prepare('DELETE FROM projects WHERE id=?').run(id).changes === 1;
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
    return { id: row.id, title: row.title, requirements: row.requirements, createdAt: row.created_at, updatedAt: row.updated_at, sources, draft: draftRow ? decodeGeneration(draftRow) : null, versions, messages };
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
  close() { this.#database.close(); }
}
