// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelWorkbench } from '@/components/model-workbench';
import type { ProjectRecord } from '@/storage/sqlite-repository';
import type { CsvAnalysis, SourceArtifactInput } from '@/domain/model';
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
const csvAnalysisFixture = (confirmed: boolean, intakeSessionId: string | null = 'intake-1'): CsvAnalysis => ({
  analysisVersion: 1,
  contentDigest: 'a'.repeat(64),
  maskingGenerationId: 'masking-1',
  intakeSessionId,
  inferredHeaderMode: 'first-row',
  headerMode: 'first-row',
  headers: ['customer_id', 'email'],
  rowCount: 1,
  columnCount: 2,
  columns: [
    { index: 0, name: 'customer_id', inferredType: 'integer', nullable: false, nullRatio: 0, uniqueRatio: 1, minLength: 1, maxLength: 1, formats: [], sensitive: true, sensitivity: ['manual'] },
    { index: 1, name: 'email', inferredType: 'string', nullable: false, nullRatio: 0, uniqueRatio: 1, minLength: 13, maxLength: 13, formats: ['email'], sensitive: true, sensitivity: ['manual'] },
  ],
  sampleRows: [{ rowIndex: 0, values: ['<masked:abc>', '<masked:def>'] }],
  additionalSensitiveColumns: [0, 1],
  confirmed,
  confirmedAt: confirmed ? '2026-10-01T00:00:00.000Z' : null,
});

describe('Michal modelling workflow', () => {
  it('reviews, masks and confirms CSV input before enabling generation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/csv-analysis' && method === 'POST') {
        const form = init?.body as FormData;
        expect((form.get('file') as File).name).toBe('customers.csv');
        return Response.json({
          content: 'customer_id,email\n1,a@example.com\n',
          analysis: csvAnalysisFixture(form.get('confirmed') === 'true'),
        });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.type(screen.getByLabelText('Model name'), 'Customer model');
    await user.type(screen.getByLabelText('Requirements'), 'Infer entities from the extract.');
    await user.upload(screen.getByLabelText('Source files'), new File(
      ['customer_id,email\n1,a@example.com\n'],
      'customers.csv',
      { type: 'text/csv' },
    ));

    const csvReview = await screen.findByRole('region', { name: 'CSV review customers.csv' }) as HTMLDetailsElement;
    expect(csvReview).toBeTruthy();
    expect(document.querySelectorAll('.csv-review')).toHaveLength(1);
    expect(document.querySelectorAll('.source-list li')).toHaveLength(0);
    expect(csvReview.querySelector(':scope > summary')?.textContent).toContain('customers.csv');
    expect(csvReview.open).toBe(false);
    await user.click(csvReview.querySelector('summary')!);
    expect(csvReview.open).toBe(true);
    expect(screen.getByText('<masked:def>')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Unmask email in customers.csv' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save before generation' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Confirm CSV customers.csv' }));
    await waitFor(() => expect(csvReview.textContent).toContain('CSV confirmed'));
    expect(csvReview.querySelector(':scope > summary')?.textContent).toContain('customers.csv');
    expect((screen.getByRole('button', { name: 'Save model' }) as HTMLButtonElement).disabled).toBe(false);

    await user.clear(screen.getByLabelText('Column 1 name for customers.csv'));
    await user.type(screen.getByLabelText('Column 1 name for customers.csv'), 'customer_key');
    expect((screen.getByRole('button', { name: 'Save model' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('invalidates a confirmed CSV after raw edits and requires reanalysis', async () => {
    let project: ProjectRecord = {
      id: 'project-csv',
      title: 'Customer model',
      requirements: 'Model customers.',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      sources: [{
        id: 'source-csv',
        ordinal: 0,
        name: 'customers.csv',
        kind: 'csv',
        content: 'customer_id,email\n1,a@example.com\n',
        csvAnalysis: csvAnalysisFixture(true, null),
      }],
      draft: structuredClone(generatedClaimPayment),
      versions: [],
      messages: [],
      providerSettings: testProviderSettings,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([{
        id: project.id, title: project.title, updatedAt: project.updatedAt, versionCount: 0, hasDraft: true,
      }]);
      if (url === `/api/projects/${project.id}` && method === 'GET') return Response.json(project);
      if (url === `/api/projects/${project.id}` && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { requirements: string; sources: SourceArtifactInput[] };
        project = {
          ...project,
          requirements: body.requirements,
          sources: body.sources.map((source, ordinal) => ({ ...source, id: `source-${ordinal}`, ordinal })),
        };
        return Response.json(project);
      }
      if (url.includes('/api/settings/provider/models')) return Response.json([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
      if (url.endsWith('/generation-jobs') && method === 'GET') return new Response(null, { status: 204 });
      if (url === '/api/csv-analysis' && method === 'POST') {
        const form = init?.body as FormData;
        return Response.json({
          content: 'customer_id,email\n1,changed@example.com\n',
          analysis: csvAnalysisFixture(form.get('confirmed') === 'true', null),
        });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await user.click(await screen.findByRole('button', { name: /Customer model/u }));
    expect(await screen.findByRole('heading', { name: 'Claim Payment model' })).toBeTruthy();
    const csvReview = screen.getByRole('region', { name: 'CSV review customers.csv' }) as HTMLDetailsElement;
    expect(csvReview.open).toBe(false);
    await user.click(csvReview.querySelector(':scope > summary')!);
    fireEvent.change(screen.getByLabelText('Source content customers.csv'), {
      target: { value: 'customer_id,email\n1,changed@example.com\n' },
    });
    expect(await screen.findByText('CSV review required')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Regenerate with changes/u }) as HTMLButtonElement).disabled).toBe(true);
    expect(csvReview.open).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Analyse CSV customers.csv' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm CSV customers.csv' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'CSV review customers.csv' }).textContent).toContain('CSV confirmed'));
    expect((screen.getByRole('button', { name: /Regenerate with changes/u }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save generation inputs' }));
    expect(await screen.findByRole('button', { name: 'Generation inputs saved' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
    expect(csvReview.open).toBe(true);
  });

  it('keeps filenames and disclosure state stable when another CSV is removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/csv-analysis' && method === 'POST') {
        const file = (init?.body as FormData).get('file') as File;
        return Response.json({
          content: `customer_id,email\n1,${file.name}@example.com\n`,
          analysis: csvAnalysisFixture(false),
        });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.type(screen.getByLabelText('Model name'), 'Multiple CSVs');
    await user.type(screen.getByLabelText('Requirements'), 'Keep each CSV distinct.');
    await user.upload(screen.getByLabelText('Source files'), [
      new File(['customer_id,email\n1,first@example.com\n'], 'first.csv', { type: 'text/csv' }),
      new File(['customer_id,email\n2,second@example.com\n'], 'second.csv', { type: 'text/csv' }),
    ]);

    const first = await screen.findByRole('region', { name: 'CSV review first.csv' }) as HTMLDetailsElement;
    const second = await screen.findByRole('region', { name: 'CSV review second.csv' }) as HTMLDetailsElement;
    await user.click(second.querySelector(':scope > summary')!);
    expect(second.open).toBe(true);
    await user.click(first.querySelector(':scope > summary')!);
    await user.click(screen.getByRole('button', { name: 'Remove CSV first.csv' }));

    expect(screen.queryByRole('region', { name: 'CSV review first.csv' })).toBeNull();
    const remaining = screen.getByRole('region', { name: 'CSV review second.csv' }) as HTMLDetailsElement;
    expect(remaining.open).toBe(true);
    expect(remaining.querySelector(':scope > summary')?.textContent).toContain('second.csv');
    expect(document.querySelectorAll('.csv-review')).toHaveLength(1);
  });

  it('ignores an upload response after the intake is reset', async () => {
    let resolveAnalysis!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/csv-analysis' && method === 'POST') {
        return new Promise<Response>(resolve => { resolveAnalysis = resolve; });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.upload(screen.getByLabelText('Source files'), new File(
      ['customer_id,email\n1,a@example.com\n'],
      'stale.csv',
      { type: 'text/csv' },
    ));
    await waitFor(() => expect((screen.getByLabelText('Source files') as HTMLInputElement).disabled).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Return home to Model Foundry' }));
    resolveAnalysis(Response.json({
      content: 'customer_id,email\n1,a@example.com\n',
      analysis: csvAnalysisFixture(false),
    }));
    await waitFor(() => expect((screen.getByLabelText('Source files') as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByRole('region', { name: 'CSV review stale.csv' })).toBeNull();
  });

  it('unlocks the intake after CSV analysis fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/csv-analysis' && method === 'POST') {
        return Response.json({ error: 'csv-malformed' }, { status: 400 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await screen.findByText('No saved models yet');
    await user.upload(screen.getByLabelText('Source files'), new File(['"unterminated'], 'bad.csv', { type: 'text/csv' }));
    expect(await screen.findByText('Source analysis failed', { exact: true })).toBeTruthy();
    expect((screen.getByLabelText('Source files') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Model name') as HTMLInputElement).disabled).toBe(false);
  });

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
    await user.click(screen.getByRole('button', { name: 'Save model' }));
    await screen.findByText('Model saved', { exact: true });
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
    const toolbarControls = screen.getByRole('toolbar', { name: 'Model representation controls' })
      .querySelector('.model-toolbar-controls');
    const chat = screen.getByRole('region', { name: 'Model chat' });
    const editor = screen.getByRole('region', { name: 'Structured model editor' });
    const review = screen.getByRole('region', { name: 'Assumptions and warnings' });
    expect(liveOutput.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chat.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbarControls?.lastElementChild?.classList.contains('status-dot')).toBe(true);
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
    const instructionSave = calls.find(call => call.url === '/api/projects/project-1'
      && call.method === 'PUT'
      && (call.body as { requirements?: string })?.requirements === 'Model claim payments and keep an auditable payment history.');
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
  }, 15_000);

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
    expect(await screen.findByText('Add a recovery transaction.')).toBeTruthy();
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
    expect(await screen.findByText('Draft the next request.')).toBeTruthy();
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
    await user.click(screen.getByRole('button', { name: 'Save model' }));
    await screen.findByText('Model saved', { exact: true });
    await user.click(screen.getByRole('button', { name: /Generate draft/u }));
    expect(await screen.findByRole('heading', { name: 'Building your model' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Model generation progress' })).toBeTruthy();

    expect((await screen.findByRole('status')).textContent).toBe('Receiving live model output…');
    expect(screen.getByLabelText('Live provider transcript').textContent).toContain('"Claim Payment"');
    await vi.waitFor(() => expect(pollCount).toBeGreaterThan(0), { timeout: 2500 });
    current = { ...current, draft: generatedClaimPayment };
    completePoll!(Response.json(generationJob(project.id, 'completed', { transcript: '{"model":{"name":"Claim Payment"}}' })));
    expect(await screen.findByRole('heading', { name: 'Claim Payment model' }, { timeout: 2500 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Building your model' })).toBeNull();
  });

  it('preserves retry lineage while editing inputs after initial generation fails', async () => {
    let project: ProjectRecord = {
      id: 'project-retry', title: 'Retry model', requirements: 'Original requirements.',
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      sources: [], draft: null, versions: [], messages: [], providerSettings: testProviderSettings,
    };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (url === '/api/projects' && method === 'GET') return Response.json([{
        id: project.id, title: project.title, updatedAt: project.updatedAt, versionCount: 0, hasDraft: Boolean(project.draft),
      }]);
      if (url === `/api/projects/${project.id}` && method === 'GET') return Response.json(project);
      if (url.includes('/api/settings/provider/models')) return Response.json([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
      if (url.endsWith('/generation-jobs') && method === 'GET') return Response.json(generationJob(project.id, 'failed'));
      if (url === `/api/projects/${project.id}` && method === 'PUT') {
        project = { ...project, requirements: (body as { requirements: string }).requirements };
        return Response.json(project);
      }
      if (url.endsWith('/generation-jobs') && method === 'POST') {
        project = { ...project, draft: structuredClone(generatedClaimPayment) };
        return Response.json(generationJob(project.id, 'completed', { retryOfJobId: 'job-1' }), { status: 202 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await user.click(await screen.findByRole('button', { name: /Retry model/u }));
    await user.click(await screen.findByRole('button', { name: 'Edit inputs' }));
    await user.clear(screen.getByLabelText('Requirements'));
    await user.type(screen.getByLabelText('Requirements'), 'Updated requirements.');
    await user.click(screen.getByRole('button', { name: 'Retry with current inputs' }));

    await screen.findByRole('heading', { name: 'Claim Payment model' });
    const updateIndex = calls.findIndex(call => call.url === `/api/projects/${project.id}` && call.method === 'PUT');
    const retryIndex = calls.findIndex(call => call.url.endsWith('/generation-jobs') && call.method === 'POST');
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect((calls[updateIndex].body as { requirements: string }).requirements).toBe('Updated requirements.');
    expect(calls[retryIndex].body).toEqual({ clarification: null, retryOfJobId: 'job-1' });
    expect(updateIndex).toBeLessThan(retryIndex);
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

  it('ignores a slower project response after a newer project is selected', async () => {
    const makeProject = (id: string, title: string, modelName: string): ProjectRecord => ({
      id,
      title,
      requirements: `Model ${title}.`,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      sources: [],
      draft: {
        ...structuredClone(generatedClaimPayment),
        model: { ...structuredClone(generatedClaimPayment.model), name: modelName },
      },
      versions: [],
      messages: [],
      providerSettings: testProviderSettings,
    });
    const first = makeProject('first', 'First project', 'First model');
    const second = makeProject('second', 'Second project', 'Second model');
    let resolveFirst!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === '/api/projects' && method === 'GET') return Response.json([first, second].map(project => ({
        id: project.id, title: project.title, updatedAt: project.updatedAt, versionCount: 0, hasDraft: true,
      })));
      if (url === '/api/projects/first') return new Promise<Response>(resolve => { resolveFirst = resolve; });
      if (url === '/api/projects/second') return Response.json(second);
      if (url.includes('/api/settings/provider/models')) return Response.json([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
      if (url.endsWith('/generation-jobs') && method === 'GET') return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const user = userEvent.setup();
    render(<ModelWorkbench />);
    await user.click(await screen.findByRole('button', { name: /First project/u }));
    await user.click(screen.getByRole('button', { name: /Second project/u }));
    expect(await screen.findByRole('heading', { name: 'Second model model' })).toBeTruthy();
    resolveFirst(Response.json(first));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'First model model' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Second model model' })).toBeTruthy();
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
