// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelWorkbench } from '@/components/model-workbench';
import type { ProjectRecord } from '@/storage/sqlite-repository';
import { generatedClaimPayment } from '../fixtures/claim-payment';

vi.mock('@/render/mermaid-client', () => ({
  renderMermaidSvg: vi.fn(async () => ({ svg: '<svg aria-label="Rendered Mermaid"><text>Claim</text></svg>' })),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const projectStream = (events: unknown[]) => new Response(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, {
  headers: { 'content-type': 'application/x-ndjson' },
});
const testProviderSettings = {
  providerType: 'vscode-agent-host' as const,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-sol',
};
const generationJob = (
  projectId: string,
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled',
  overrides: Record<string, unknown> = {},
) => ({
  id: 'job-1', projectId, status, providerSettings: testProviderSettings,
  phase: status === 'completed' ? 'completed' : status === 'running' ? 'receiving' : status,
  message: status === 'completed' ? 'Draft ready.' : status === 'running' ? 'Receiving live model output…' : `Generation ${status}.`,
  transcript: status === 'running' ? '{"model":{"name":"Claim Payment"' : '',
  error: status === 'failed' ? 'provider-failed' : null,
  createdAt: '2026-09-22T00:00:00Z', startedAt: '2026-09-22T00:00:01Z',
  heartbeatAt: '2026-09-22T00:00:02Z', completedAt: status === 'completed' ? '2026-09-22T00:00:03Z' : null,
  updatedAt: '2026-09-22T00:00:02Z', ...overrides,
});

describe('Michal modelling workflow', () => {
  it('creates from text and files, edits the draft, saves a version and exposes downloads', async () => {
    const project: ProjectRecord = {
      id: 'project-1', title: 'Claim Payment', requirements: 'Model claim payments.',
      createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
      sources: [{ id: 'source-1', ordinal: 0, name: 'claims.ddl', kind: 'ddl', content: 'CREATE TABLE claim(id UUID);' }],
      draft: null, versions: [], messages: [], providerSettings: testProviderSettings,
    };
    let current = project;
    const generatedWithQuestion = {
      ...structuredClone(generatedClaimPayment),
      warnings: ['Confirm whether external payment references must be unique.'],
      clarificationQuestions: ['Should an external payment reference be unique?'],
    };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/projects' && method === 'POST') { current = { ...project, ...(body as object) }; return Response.json(current, { status: 201 }); }
      if (url === '/api/projects/project-1' && method === 'PUT') { current = { ...current, ...(body as object) }; return Response.json(current); }
      if (url.endsWith('/generation-jobs') && method === 'POST') {
        current = { ...current, draft: generatedWithQuestion };
        return Response.json(generationJob(current.id, 'completed'), { status: 202 });
      }
      if (url.endsWith('/draft')) { current = { ...current, draft: body as typeof generatedClaimPayment }; return Response.json(body); }
      if (url.endsWith('/chat')) {
        const userMessage = (body as { message: string }).message;
        const answeringQuestion = userMessage.startsWith('Yes,');
        current = { ...current, draft: {
          ...generatedClaimPayment,
          model: {
            ...generatedClaimPayment.model,
            businessDefinition: answeringQuestion
              ? 'Tracks claim payments with unique platform references.'
              : 'Includes recovery transactions.',
          },
        }, messages: [
          ...(current.messages ?? []),
          { id: `message-${(current.messages?.length ?? 0) + 1}`, role: 'user', content: userMessage, createdAt: '2026-09-22T00:02:00Z' },
          { id: `message-${(current.messages?.length ?? 0) + 2}`, role: 'assistant', content: answeringQuestion ? 'I applied the uniqueness requirement and cleared the question.' : 'I added recovery transactions.', createdAt: '2026-09-22T00:02:01Z' },
        ] };
        return projectStream([{ type: 'result', project: current }]);
      }
      if (url.endsWith('/versions')) {
        const version = { ...generatedClaimPayment, id: 'version-1', projectId: 'project-1', versionNumber: 1,
          createdAt: '2026-09-22T00:01:00Z', sources: current.sources, mermaid: 'erDiagram', drawio: '<mxfile/>' };
        current = { ...current, versions: [{ id: version.id, versionNumber: 1, createdAt: version.createdAt }] };
        return Response.json(version, { status: 201 });
      }
      if (url === '/api/projects/project-1') return Response.json(current);
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.type(screen.getByLabelText('Model name'), 'Claim Payment');
    await user.type(screen.getByLabelText('Requirements'), 'Model claim payments.');
    await user.upload(screen.getByLabelText('Source files'), new File(['CREATE TABLE claim(id UUID);'], 'claims.ddl', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: /Generate draft/u }));

    expect(await screen.findByRole('heading', { name: 'Claim Payment model' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Model chat' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Open model assistant/u }));
    expect(screen.getByRole('region', { name: 'Model chat' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Model chat' })).toBeNull();
    expect(screen.getByRole('button', { name: /Open model assistant/u })).toBe(document.activeElement);
    await user.click(screen.getByRole('button', { name: /Open model assistant/u }));
    const assumptionsCard = document.querySelector<HTMLDetailsElement>('details.assumptions-card');
    const warningsCard = document.querySelector<HTMLDetailsElement>('details.warnings-card');
    expect(assumptionsCard?.open).toBe(false);
    expect(warningsCard?.open).toBe(false);
    await user.click(assumptionsCard!.querySelector('summary')!);
    expect(screen.getByText('A claim uses one currency for approval and payments.')).toBeTruthy();
    expect((calls.find(call => call.url === '/api/projects' && call.method === 'POST')?.body as { sources: Array<{ kind: string }> }).sources[0].kind).toBe('ddl');
    const entitiesEditor = document.querySelector<HTMLDetailsElement>('details.entities-editor');
    expect(entitiesEditor?.open).toBe(false);
    const entityEditors = [...document.querySelectorAll<HTMLDetailsElement>('details.entity-editor')];
    expect(entityEditors).toHaveLength(2);
    expect(entityEditors.every(section => !section.open)).toBe(true);
    await user.click(entitiesEditor!.querySelector('summary')!);
    await user.click(entityEditors[0].querySelector('summary')!);
    expect(screen.getByLabelText('claim_id reference')).toBeTruthy();

    const relationshipEditor = screen.getByText('Relationships').closest('details');
    const rulesEditor = screen.getByText('Validation rules').closest('details');
    const history = screen.getByText('Version history').closest('details');
    expect(relationshipEditor?.open).toBe(false);
    expect(rulesEditor?.open).toBe(false);
    expect(history?.open).toBe(false);

    const liveOutput = screen.getByRole('region', { name: 'Live model output' });
    const chat = screen.getByRole('region', { name: 'Model chat' });
    const editor = screen.getByRole('region', { name: 'Structured model editor' });
    const review = screen.getByRole('region', { name: 'Assumptions and warnings' });
    expect(liveOutput.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chat.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Interactive model canvas' })).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('75%')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reset model view' }));
    expect(screen.getByText('50%')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.model-export-source .mermaid-preview svg')).toBeTruthy());
    expect(document.querySelector('.model-export-source .diagram-preview')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'draw.io' }));
    expect(document.querySelector('.model-canvas .diagram-preview')).toBeTruthy();
    expect(document.querySelector('.model-export-source .mermaid-preview svg')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Mermaid diagram image' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export Mermaid diagram and model details to PDF' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Model chat' }).textContent).toContain('Should an external payment reference be unique?');
    expect(screen.queryByLabelText('Clarification answer')).toBeNull();

    const instructions = screen.getByLabelText('Persistent model instructions');
    expect((instructions as HTMLTextAreaElement).value).toBe('Model claim payments.');
    await user.clear(instructions);
    await user.type(instructions, 'Model claim payments and keep an auditable payment history.');
    expect(calls.filter(call => call.url.endsWith('/chat'))).toHaveLength(0);

    await user.type(screen.getByLabelText('Message the model assistant'), 'Yes, within the payment platform.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('I applied the uniqueness requirement and cleared the question.')).toBeTruthy();
    const instructionSave = calls.find(call => call.url === '/api/projects/project-1' && call.method === 'PUT');
    const chatCall = calls.find(call => call.url.endsWith('/chat'));
    expect((instructionSave?.body as { requirements: string }).requirements).toBe('Model claim payments and keep an auditable payment history.');
    expect(calls.indexOf(instructionSave!)).toBeLessThan(calls.indexOf(chatCall!));
    expect(screen.getByDisplayValue('Tracks claim payments with unique platform references.')).toBeTruthy();
    expect(screen.queryByText('Should an external payment reference be unique?')).toBeNull();

    const entityName = screen.getByLabelText('Entity name Claim');
    await user.clear(entityName);
    await user.type(entityName, 'Insurance Claim');
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/draft') && JSON.stringify(call.body).includes('Insurance Claim'))).toBe(true));
    await user.click(rulesEditor!.querySelector('summary')!);
    const ruleExpression = screen.getByLabelText('Rule 1 expression');
    await user.clear(ruleExpression);
    await user.type(ruleExpression, 'paid_total <= approved_amount');
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/draft') && JSON.stringify(call.body).includes('paid_total <= approved_amount'))).toBe(true));
    await user.click(relationshipEditor!.querySelector('summary')!);
    await user.click(screen.getByRole('button', { name: /Add relationship/u }));
    expect(screen.getByLabelText('Relationship 2 name')).toBeTruthy();
    await user.type(screen.getByLabelText('Message the model assistant'), 'Add recovery transactions.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('I added recovery transactions.')).toBeTruthy();
    expect(screen.getByDisplayValue('Includes recovery transactions.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await user.click(history!.querySelector('summary')!);
    expect((await screen.findByRole('link', { name: 'Download Mermaid v1' })).getAttribute('href')).toBe('/api/projects/project-1/downloads/mermaid?version=1');
    expect(screen.getByRole('link', { name: 'Download draw.io v1' }).getAttribute('href')).toBe('/api/projects/project-1/downloads/drawio?version=1');

    const regenerationStart = calls.length;
    fireEvent.change(screen.getByLabelText('Canonical model business definition'), {
      target: { value: 'Unsaved definition included in regeneration.' },
    });
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(calls.slice(regenerationStart).some(call => call.url.endsWith('/generation-jobs'))).toBe(true));
    const regenerationCalls = calls.slice(regenerationStart);
    const draftSave = regenerationCalls.findIndex(call => call.url.endsWith('/draft'));
    const intakeSave = regenerationCalls.findIndex(call => call.url === '/api/projects/project-1' && call.method === 'PUT');
    const jobStart = regenerationCalls.findIndex(call => call.url.endsWith('/generation-jobs'));
    expect(draftSave).toBeGreaterThanOrEqual(0);
    expect((regenerationCalls[draftSave].body as typeof generatedClaimPayment).model.businessDefinition)
      .toBe('Unsaved definition included in regeneration.');
    expect(draftSave).toBeLessThan(intakeSave);
    expect(intakeSave).toBeLessThan(jobStart);
  });

  it('shows chat messages immediately, keeps the composer usable and recovers failed sends', async () => {
    const project: ProjectRecord = {
      id: 'project-1', title: 'Claim Payment', requirements: 'Model claim payments.',
      createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', sources: [],
      draft: structuredClone(generatedClaimPayment), versions: [],
      providerSettings: testProviderSettings,
      messages: [
        { id: 'message-1', role: 'user', content: 'Keep payment history.', createdAt: '2026-09-22T00:01:00Z' },
        { id: 'message-2', role: 'assistant', content: 'Payment history remains in the model.', createdAt: '2026-09-22T00:01:01Z' },
      ],
    };
    const pendingResponses: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([{
        id: project.id, title: project.title, updatedAt: project.updatedAt, versionCount: 0, hasDraft: true,
      }]);
      if (url === `/api/projects/${project.id}` && method === 'GET') return Response.json(project);
      if (url.includes('/api/settings/provider/models')) return Response.json([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
      if (url.endsWith('/generation-jobs') && method === 'GET') return new Response(null, { status: 204 });
      if (url.endsWith('/chat')) return new Promise<Response>(resolve => pendingResponses.push(resolve));
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await user.click(await screen.findByRole('button', { name: /Claim Payment/u }));
    expect(await screen.findByRole('heading', { name: 'Claim Payment model' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Open model assistant/u }));
    expect(screen.getByText('Keep payment history.')).toBeTruthy();

    const composer = screen.getByLabelText('Message the model assistant');
    await user.type(composer, 'Add a recovery transaction.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByText('Add a recovery transaction.')).toBeTruthy();
    expect(document.querySelector('.thinking-visible')?.textContent).toContain('Connecting to the configured provider');
    expect(document.querySelectorAll('.thinking-dots i')).toHaveLength(3);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect((composer as HTMLTextAreaElement).value).toBe('');
    const structuredFields = screen.getByLabelText('Canonical model business definition')
      .closest<HTMLFieldSetElement>('fieldset.structured-editor-fields');
    expect(structuredFields?.disabled).toBe(true);
    await user.type(composer, 'Draft the next request.');

    const successful = {
      ...project,
      messages: [...project.messages,
        { id: 'message-3', role: 'user' as const, content: 'Add a recovery transaction.', createdAt: '2026-09-22T00:02:00Z' },
        { id: 'message-4', role: 'assistant' as const, content: 'Recovery transaction added.', createdAt: '2026-09-22T00:02:01Z' },
      ],
    };
    pendingResponses.shift()!(projectStream([{ type: 'result', project: successful }]));
    expect(await screen.findByText('Recovery transaction added.')).toBeTruthy();
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect((composer as HTMLTextAreaElement).value).toBe('Draft the next request.');
    expect(screen.getByText('Keep payment history.')).toBeTruthy();
    expect(structuredFields?.disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByText('Draft the next request.')).toBeTruthy();
    expect(document.querySelector('.thinking-visible')?.textContent).toContain('Connecting to the configured provider');
    pendingResponses.shift()!(projectStream([{ type: 'error', error: 'provider-timeout' }]));
    expect(await screen.findByText(/provider did not finish/iu)).toBeTruthy();
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect((composer as HTMLTextAreaElement).value).toBe('Draft the next request.');
  });

  it('opens the model build screen and streams progress before applying the validated model', async () => {
    const project: ProjectRecord = {
      id: 'project-1', title: 'Claim Payment', requirements: 'Model claim payments.',
      createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
      sources: [], draft: null, versions: [], messages: [], providerSettings: testProviderSettings,
    };
    let pollCount = 0;
    let current = project;
    let completePoll: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/projects' && method === 'POST') return Response.json(current, { status: 201 });
      if (url.endsWith('/generation-jobs') && method === 'POST') return Response.json(generationJob(project.id, 'running'), { status: 202 });
      if (url === '/api/generation-jobs/job-1') {
        pollCount += 1;
        return new Promise<Response>(resolve => { completePoll = resolve; });
      }
      if (url === `/api/projects/${project.id}`) return Response.json(current);
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.type(screen.getByLabelText('Model name'), 'Claim Payment');
    await user.type(screen.getByLabelText('Requirements'), 'Model claim payments.');
    await user.click(screen.getByRole('button', { name: /Generate draft/u }));
    expect(await screen.findByRole('heading', { name: 'Building your model' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Model generation progress' })).toBeTruthy();

    expect(await screen.findByText('Receiving live model output…')).toBeTruthy();
    expect(screen.getByLabelText('Live provider transcript').textContent).toContain('"Claim Payment"');
    await vi.waitFor(() => expect(pollCount).toBeGreaterThan(0));
    current = { ...current, draft: generatedClaimPayment };
    completePoll!(Response.json(generationJob(project.id, 'completed', { transcript: '{"model":{"name":"Claim Payment"}}' })));
    expect(await screen.findByRole('heading', { name: 'Claim Payment model' }, { timeout: 2500 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Building your model' })).toBeNull();
  });

  it('makes external transmission and AustralianSuper branding visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    render(<ModelWorkbench />);
    expect(await screen.findByText(/Generate sends the supplied material to the configured provider/u)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'AustralianSuper' })).toBeTruthy();
  });

  it('opens provider settings, collapses navigation and returns home from the brand', async () => {
    let settings = { baseUrl: 'https://api.openai.com/v1', model: 'environment-model', providerType: 'openai' as const, apiKeyConfigured: true };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/projects') return Response.json([]);
      if (url.startsWith('/api/settings/provider/models')) return Response.json([]);
      if (url === '/api/settings/provider' && method === 'GET') return Response.json(settings);
      if (url === '/api/settings/provider' && method === 'PUT') {
        settings = { ...(body as typeof settings), apiKeyConfigured: true };
        return Response.json(settings);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    expect(screen.getByText('Data Model Design Space')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Collapse workspace sidebar' }));
    expect(document.querySelector('.workspace')?.classList.contains('sidebar-collapsed')).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand workspace sidebar' }).getAttribute('aria-expanded')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Provider settings' }));
    expect(await screen.findByRole('heading', { name: 'Provider settings' })).toBeTruthy();
    await user.clear(screen.getByLabelText('Provider base URL'));
    await user.type(screen.getByLabelText('Provider base URL'), 'https://models.example/v1');
    await user.clear(screen.getByLabelText('Provider model'));
    await user.type(screen.getByLabelText('Provider model'), 'claims-model');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved')).toBeTruthy();
    expect(calls.find(call => call.url === '/api/settings/provider' && call.method === 'PUT')?.body).toEqual({
      providerType: 'openai', baseUrl: 'https://models.example/v1', model: 'claims-model',
    });

    await user.click(screen.getByRole('button', { name: 'Return home to Model Foundry' }));
    expect(screen.getByRole('heading', { name: 'Start with what you know' })).toBeTruthy();
  });

  it('describes GitHub Copilot authentication without exposing an API key field', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') return Response.json([]);
      if (url.startsWith('/api/settings/provider/models')) return Response.json([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
      if (url === '/api/settings/provider') return Response.json({
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol', providerType: 'copilot-sdk', apiKeyConfigured: false,
      });
      throw new Error(`unexpected request ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.click(screen.getByRole('button', { name: 'Provider settings' }));
    expect(await screen.findByText('GitHub Copilot OAuth selected')).toBeTruthy();
    expect(screen.queryByLabelText('Provider base URL')).toBeNull();
    expect((screen.getByLabelText('Provider model') as HTMLInputElement | HTMLSelectElement).value).toBe('gpt-5.6-sol');
  });

  it('describes the VS Code bridge without exposing provider credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') return Response.json([]);
      if (url.startsWith('/api/settings/provider/models')) return Response.json([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
      if (url === '/api/settings/provider') return Response.json({
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol', providerType: 'vscode-agent-host', apiKeyConfigured: false,
      });
      throw new Error(`unexpected request ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.click(screen.getByRole('button', { name: 'Provider settings' }));
    expect(await screen.findByText('VS Code Copilot bridge selected')).toBeTruthy();
    expect(screen.queryByLabelText('Provider base URL')).toBeNull();
    expect(screen.getByText(/No credential leaves VS Code/iu)).toBeTruthy();
  });

  it('saves, edits and deletes a model before provider generation', async () => {
    let current: ProjectRecord | null = null;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('confirm', vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/projects' && method === 'GET') return Response.json(current ? [{
        id: current.id, title: current.title, updatedAt: current.updatedAt, versionCount: 0, hasDraft: false,
      }] : []);
      if (url === '/api/projects' && method === 'POST') {
        current = {
          id: 'project-1', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
          title: (body as { title: string }).title, requirements: (body as { requirements: string }).requirements,
          sources: [], draft: null, versions: [],
          messages: [], providerSettings: testProviderSettings,
        };
        return Response.json(current, { status: 201 });
      }
      if (url === '/api/projects/project-1' && method === 'PUT') {
        current = { ...current!, ...(body as Pick<ProjectRecord, 'title' | 'requirements'>) };
        return Response.json(current);
      }
      if (url === '/api/projects/project-1' && method === 'DELETE') { current = null; return new Response(null, { status: 204 }); }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.type(screen.getByLabelText('Model name'), 'Claim Payment');
    await user.type(screen.getByLabelText('Requirements'), 'Initial requirements.');
    await user.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findByRole('button', { name: 'Delete model' })).toBeTruthy();
    expect(calls.some(call => call.url === '/api/projects' && call.method === 'POST')).toBe(true);

    const requirements = screen.getByLabelText('Requirements');
    await user.clear(requirements);
    await user.type(requirements, 'Revised requirements.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(calls.some(call => call.method === 'PUT' && (call.body as { requirements?: string })?.requirements === 'Revised requirements.')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Delete model' }));
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete model' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete model' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('cannot be undone'));
    expect(await screen.findByText('No saved models yet')).toBeTruthy();
    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
  });
});
