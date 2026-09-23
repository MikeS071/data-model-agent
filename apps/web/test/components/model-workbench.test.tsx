// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelWorkbench } from '@/components/model-workbench';
import type { ProjectRecord } from '@/storage/sqlite-repository';
import { generatedClaimPayment } from '../fixtures/claim-payment';

vi.mock('mermaid', () => ({ default: {
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg aria-label="Rendered Mermaid"><text>Claim</text></svg>' })),
} }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Michal modelling workflow', () => {
  it('creates from text and files, edits the draft, saves a version and exposes downloads', async () => {
    const project: ProjectRecord = {
      id: 'project-1', title: 'Claim Payment', requirements: 'Model claim payments.',
      createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
      sources: [{ id: 'source-1', ordinal: 0, name: 'claims.ddl', kind: 'ddl', content: 'CREATE TABLE claim(id UUID);' }],
      draft: null, versions: [], messages: [],
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
      if (url.endsWith('/generate')) { current = { ...current, draft: generatedWithQuestion }; return Response.json(current); }
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
        return Response.json(current);
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
    expect(screen.getByText('A claim uses one currency for approval and payments.')).toBeTruthy();
    expect((calls.find(call => call.url === '/api/projects' && call.method === 'POST')?.body as { sources: Array<{ kind: string }> }).sources[0].kind).toBe('ddl');
    expect(screen.getByLabelText('claim_id reference')).toBeTruthy();

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
    expect(screen.getByRole('region', { name: 'Model chat' }).textContent).toContain('Should an external payment reference be unique?');
    expect(screen.queryByLabelText('Clarification answer')).toBeNull();

    await user.type(screen.getByLabelText('Message the model assistant'), 'Yes, within the payment platform.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('I applied the uniqueness requirement and cleared the question.')).toBeTruthy();
    expect(screen.getByDisplayValue('Tracks claim payments with unique platform references.')).toBeTruthy();
    expect(screen.queryByText('Should an external payment reference be unique?')).toBeNull();

    const entityName = screen.getByLabelText('Entity name Claim');
    await user.clear(entityName);
    await user.type(entityName, 'Insurance Claim');
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/draft') && JSON.stringify(call.body).includes('Insurance Claim'))).toBe(true));
    const ruleExpression = screen.getByLabelText('Rule 1 expression');
    await user.clear(ruleExpression);
    await user.type(ruleExpression, 'paid_total <= approved_amount');
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/draft') && JSON.stringify(call.body).includes('paid_total <= approved_amount'))).toBe(true));
    await user.click(screen.getByRole('button', { name: /Add relationship/u }));
    expect(screen.getByLabelText('Relationship 2 name')).toBeTruthy();
    await user.type(screen.getByLabelText('Message the model assistant'), 'Add recovery transactions.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('I added recovery transactions.')).toBeTruthy();
    expect(screen.getByDisplayValue('Includes recovery transactions.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect((await screen.findByRole('link', { name: 'Download Mermaid v1' })).getAttribute('href')).toBe('/api/projects/project-1/downloads/mermaid?version=1');
    expect(screen.getByRole('link', { name: 'Download draw.io v1' }).getAttribute('href')).toBe('/api/projects/project-1/downloads/drawio?version=1');
  });

  it('makes external transmission and local-pilot limits visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    render(<ModelWorkbench />);
    expect(await screen.findByText(/Generate sends the supplied material to the configured provider/u)).toBeTruthy();
    expect(screen.getByText(/local single-user pilot/iu)).toBeTruthy();
  });

  it('opens provider settings, collapses navigation and returns home from the brand', async () => {
    let settings = { baseUrl: 'https://api.openai.com/v1', model: 'environment-model', apiKeyConfigured: true };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/projects') return Response.json([]);
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
      baseUrl: 'https://models.example/v1', model: 'claims-model',
    });

    await user.click(screen.getByRole('button', { name: 'Return home to Model Foundry' }));
    expect(screen.getByRole('heading', { name: 'Start with what you know' })).toBeTruthy();
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
          messages: [],
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
