import type { CanonicalModel, SourceArtifactInput } from '@/domain/model';

export interface GenerationRequest {
  requirements: string;
  sources: SourceArtifactInput[];
  currentModel: CanonicalModel | null;
  clarification: string | null;
}

export interface ModelProvider {
  generate(request: GenerationRequest): Promise<unknown>;
}
