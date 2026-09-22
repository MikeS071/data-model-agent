import type { CanonicalModel, SourceArtifactInput } from '@/domain/model';

export interface GenerationRequest {
  requirements: string;
  sources: SourceArtifactInput[];
  currentModel: CanonicalModel | null;
  clarification: string | null;
}

export interface RevisionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RevisionRequest extends GenerationRequest {
  message: string;
  history: RevisionMessage[];
}

export interface ModelProvider {
  generate(request: GenerationRequest): Promise<unknown>;
  revise(request: RevisionRequest): Promise<unknown>;
}
