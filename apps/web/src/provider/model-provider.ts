import type { CanonicalModel, ProviderSourceInput } from '@/domain/model';

export interface GenerationRequest {
  requirements: string;
  sources: ProviderSourceInput[];
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

export type ProviderProgressPhase = 'connecting' | 'selecting-model' | 'preparing' | 'generating' | 'receiving' | 'validating' | 'saving';

export interface ProviderProgress {
  phase: ProviderProgressPhase;
  message: string;
  transcriptDelta?: string;
}

export type ProviderProgressHandler = (progress: ProviderProgress) => void;

export interface ModelProvider {
  generate(request: GenerationRequest, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown>;
  revise(request: RevisionRequest, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown>;
}
