import { expect, test } from '@playwright/test';
import { generatedClaimPayment } from '../test/fixtures/claim-payment';

test('Michal can generate, refine, preview and version a claim payment model', async ({ page }) => {
  let generationCount = 0;
  let clarificationSent = '';
  let created = false;
  const project = {
    id: 'project-1',
    title: 'Claim Payment',
    requirements: 'Model claim payments for a large insurance organisation.',
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
    sources: [{
      id: 'source-1', ordinal: 0, name: 'claims.ddl', kind: 'ddl',
      content: 'CREATE TABLE claim(id UUID PRIMARY KEY);',
    }],
    draft: null as typeof generatedClaimPayment | null,
    versions: [] as Array<{ id: string; versionNumber: number; createdAt: string }>,
  };

  await page.route('**/api/projects**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (path === '/api/projects' && method === 'GET') return json(created ? [{
      id: project.id,
      title: project.title,
      updatedAt: project.updatedAt,
      versionCount: project.versions.length,
      hasDraft: project.draft !== null,
    }] : []);
    if (path === '/api/projects' && method === 'POST') {
      const input = request.postDataJSON() as { title: string; requirements: string };
      Object.assign(project, { title: input.title, requirements: input.requirements });
      created = true;
      return json(project, 201);
    }
    if (path.endsWith('/generate') && method === 'POST') {
      generationCount += 1;
      clarificationSent = (request.postDataJSON() as { clarification: string | null }).clarification ?? '';
      project.draft = generationCount === 1
        ? { ...structuredClone(generatedClaimPayment), warnings: ['Confirm whether external payment references must be unique.'], clarificationQuestions: ['Should an external payment reference be unique?'] }
        : structuredClone(generatedClaimPayment);
      return json(project);
    }
    if (path.endsWith('/draft') && method === 'PUT') {
      project.draft = request.postDataJSON() as typeof generatedClaimPayment;
      return json(project.draft);
    }
    if (path.endsWith('/versions') && method === 'POST') {
      project.versions = [{ id: 'version-1', versionNumber: 1, createdAt: '2026-09-22T00:01:00Z' }];
      return json({ ...project.draft, ...project.versions[0], projectId: project.id }, 201);
    }
    if (path.endsWith('/versions/1') && method === 'POST') return json(project.draft);
    if (path.endsWith('/downloads/mermaid') && method === 'GET') return route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'content-disposition': 'attachment; filename="claim-payment-v1.mmd"' },
      body: 'erDiagram\n  CLAIM ||--o{ PAYMENT : has',
    });
    if (path.endsWith('/downloads/drawio') && method === 'GET') return route.fulfill({
      status: 200,
      contentType: 'application/xml',
      headers: { 'content-disposition': 'attachment; filename="claim-payment-v1.drawio"' },
      body: '<mxfile><diagram name="Claim Payment" /></mxfile>',
    });
    if (path === `/api/projects/${project.id}` && method === 'GET') return json(project);
    return route.abort('failed');
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Turn complex requirements/u })).toBeVisible();
  await expect(page.getByText(/Generate sends the supplied material to OpenAI/u)).toBeVisible();

  await page.getByLabel('Model name').fill('Claim Payment');
  await page.getByLabel('Requirements').fill('Model claim payments for a large insurance organisation.');
  await page.getByLabel('Source files').setInputFiles({
    name: 'claims.ddl', mimeType: 'text/plain', buffer: Buffer.from('CREATE TABLE claim(id UUID PRIMARY KEY);'),
  });
  await expect(page.getByText('claims.ddl')).toBeVisible();
  await page.getByRole('button', { name: /Generate draft/u }).click();

  await expect(page.getByRole('heading', { name: 'Claim Payment model' })).toBeVisible();
  await expect(page.getByText('A claim uses one currency for approval and payments.')).toBeVisible();
  await expect(page.getByText('Should an external payment reference be unique?')).toBeVisible();
  await expect(page.locator('.mermaid-preview svg')).toBeVisible();

  await page.getByLabel('Clarification answer').fill('Yes, within the payment platform.');
  await page.getByRole('button', { name: /Update draft/u }).click();
  await expect(page.getByText('No open questions')).toBeVisible();
  expect(clarificationSent).toBe('Yes, within the payment platform.');

  const entityName = page.getByLabel('Entity name Claim');
  await entityName.fill('Insurance Claim');
  await expect(page.getByText('Draft saved')).toBeVisible();

  await page.getByRole('button', { name: 'draw.io' }).click();
  await expect(page.getByRole('img', { name: 'draw.io model preview' })).toBeVisible();
  await page.getByText(/Canonical JSON/u).click();
  await expect(page.locator('pre').filter({ hasText: 'Insurance Claim' })).toBeVisible();

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('Version 1')).toBeVisible();
  const mermaidLink = page.getByRole('link', { name: 'Download Mermaid v1' });
  const drawioLink = page.getByRole('link', { name: 'Download draw.io v1' });
  await expect(mermaidLink).toHaveAttribute('href', /version=1/u);
  await expect(drawioLink).toHaveAttribute('href', /version=1/u);

  const [mermaidDownload] = await Promise.all([page.waitForEvent('download'), mermaidLink.click()]);
  expect(mermaidDownload.suggestedFilename()).toBe('claim-payment-v1.mmd');
  const [drawioDownload] = await Promise.all([page.waitForEvent('download'), drawioLink.click()]);
  expect(drawioDownload.suggestedFilename()).toBe('claim-payment-v1.drawio');

  await page.getByRole('button', { name: 'Open as draft' }).click();
  await expect(page.getByText('Version 1 opened as working draft')).toBeVisible();
  await expect(page.locator('.project-item').filter({ hasText: 'Claim Payment' })).toContainText('1 version');
  await page.screenshot({ path: 'test-results/claim-payment-workflow.png', fullPage: true });
});
