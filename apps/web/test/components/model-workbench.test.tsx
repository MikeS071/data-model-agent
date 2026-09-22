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
      draft: null, versions: [],
    };
    let current = project;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/projects' && method === 'GET') return Response.json([]);
      if (url === '/api/projects' && method === 'POST') { current = { ...project, ...(body as object) }; return Response.json(current, { status: 201 }); }
      if (url.endsWith('/generate')) { current = { ...current, draft: generatedClaimPayment }; return Response.json(current); }
      if (url.endsWith('/draft')) { current = { ...current, draft: body as typeof generatedClaimPayment }; return Response.json(body); }
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
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect((await screen.findByRole('link', { name: 'Download Mermaid v1' })).getAttribute('href')).toBe('/api/projects/project-1/downloads/mermaid?version=1');
    expect(screen.getByRole('link', { name: 'Download draw.io v1' }).getAttribute('href')).toBe('/api/projects/project-1/downloads/drawio?version=1');
  });

  it('makes external transmission and local-pilot limits visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    render(<ModelWorkbench />);
    expect(await screen.findByText(/Generate sends the supplied material to OpenAI/u)).toBeTruthy();
    expect(screen.getByText(/local single-user pilot/iu)).toBeTruthy();
  });
});
