import { expect, test } from '@playwright/test';
import { generatedClaimPayment } from '../test/fixtures/claim-payment';

test('Michal can generate, refine, preview and version a claim payment model', async ({ page }) => {
  let generationCount = 0;
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
    messages: [] as Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>,
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
    if (path === `/api/projects/${project.id}` && method === 'PUT') {
      const input = request.postDataJSON() as { title: string; requirements: string };
      Object.assign(project, { title: input.title, requirements: input.requirements });
      return json(project);
    }
    if (path.endsWith('/generate') && method === 'POST') {
      generationCount += 1;
      project.draft = generationCount === 1
        ? { ...structuredClone(generatedClaimPayment), warnings: ['Confirm whether external payment references must be unique.'], clarificationQuestions: ['Should an external payment reference be unique?'] }
        : structuredClone(generatedClaimPayment);
      return json(project);
    }
    if (path.endsWith('/draft') && method === 'PUT') {
      project.draft = request.postDataJSON() as typeof generatedClaimPayment;
      return json(project.draft);
    }
    if (path.endsWith('/chat') && method === 'POST') {
      const message = (request.postDataJSON() as { message: string }).message;
      const answeringQuestion = message.startsWith('Yes,');
      project.draft = {
        ...structuredClone(generatedClaimPayment),
        model: {
          ...structuredClone(generatedClaimPayment.model),
          businessDefinition: answeringQuestion
            ? 'Tracks claim payments with unique platform references.'
            : 'Tracks claims, payments and recovery transactions.',
        },
      };
      project.messages = [...project.messages,
        { id: `message-${project.messages.length + 1}`, role: 'user', content: message, createdAt: '2026-09-22T00:02:00Z' },
        { id: `message-${project.messages.length + 2}`, role: 'assistant', content: answeringQuestion
          ? 'I applied the uniqueness requirement and cleared the question.'
          : 'I added recovery transactions and updated the model definition.', createdAt: '2026-09-22T00:02:01Z' },
      ];
      return json(project);
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
  await page.getByRole('button', { name: 'Save model' }).click();
  await expect(page.getByText('Model saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete model' })).toBeVisible();
  await page.getByRole('button', { name: /Generate draft/u }).click();

  await expect(page.getByRole('heading', { name: 'Claim Payment model' })).toBeVisible();
  await expect(page.getByText('A claim uses one currency for approval and payments.')).toBeVisible();
  await expect(page.getByText('Should an external payment reference be unique?')).toBeVisible();
  await expect(page.locator('.mermaid-preview svg')).toBeVisible();
  const modelCanvas = page.getByRole('group', { name: 'Interactive model canvas' });
  const canvasContent = modelCanvas.locator('.model-canvas-content');
  await expect(canvasContent).toHaveAttribute('data-scale', '1');
  const canvasBox = await modelCanvas.boundingBox();
  expect(canvasBox).toBeTruthy();
  const scrollBeforeZoom = await page.evaluate(() => window.scrollY);
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.wheel(0, -420);
  await expect.poll(async () => Number(await canvasContent.getAttribute('data-scale'))).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeZoom);

  const panBeforeDrag = Number(await canvasContent.getAttribute('data-offset-x'));
  await page.mouse.down();
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2 + 70, canvasBox!.y + canvasBox!.height / 2 + 45, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await canvasContent.getAttribute('data-offset-x'))).toBeGreaterThan(panBeforeDrag);
  const panBeforeKeyboard = Number(await canvasContent.getAttribute('data-offset-x'));
  await modelCanvas.press('ArrowRight');
  await expect.poll(async () => Number(await canvasContent.getAttribute('data-offset-x'))).toBeGreaterThan(panBeforeKeyboard);
  await page.getByRole('button', { name: 'Reset model view' }).click();
  await expect(canvasContent).toHaveAttribute('data-scale', '1');
  await expect(canvasContent).toHaveAttribute('data-offset-x', '0');
  await expect(canvasContent).toHaveAttribute('data-offset-y', '0');
  const entityEditors = page.locator('details.entity-editor');
  await expect(entityEditors).toHaveCount(2);
  await expect(entityEditors.nth(0)).toHaveAttribute('open', '');
  await expect(entityEditors.nth(1)).not.toHaveAttribute('open', '');
  await entityEditors.nth(1).locator('summary').click();
  await expect(page.getByLabel('Entity name Payment')).toBeVisible();

  const liveOutput = page.getByRole('region', { name: 'Live model output' });
  const chat = page.getByRole('region', { name: 'Model chat' });
  const editor = page.getByRole('region', { name: 'Structured model editor' });
  const review = page.getByRole('region', { name: 'Assumptions and warnings' });
  const outputBox = await liveOutput.boundingBox();
  const chatBox = await chat.boundingBox();
  const editorBox = await editor.boundingBox();
  const reviewBox = await review.boundingBox();
  expect(outputBox && chatBox && outputBox.x + outputBox.width <= chatBox.x + 1).toBeTruthy();
  expect(outputBox && chatBox && editorBox && editorBox.y >= Math.max(outputBox.y + outputBox.height, chatBox.y + chatBox.height) - 1).toBeTruthy();
  expect(editorBox && reviewBox && reviewBox.y >= editorBox.y + editorBox.height - 1).toBeTruthy();

  await page.getByLabel('Message the model assistant').fill('Yes, within the payment platform.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('I applied the uniqueness requirement and cleared the question.')).toBeVisible();
  await expect(page.getByText('Should an external payment reference be unique?')).toHaveCount(0);
  await expect(page.getByLabel('Canonical model business definition')).toHaveValue('Tracks claim payments with unique platform references.');

  const entityName = page.getByLabel('Entity name Claim');
  await entityName.fill('Insurance Claim');
  await expect(page.getByText('Draft saved')).toBeVisible();

  await page.getByRole('button', { name: 'draw.io' }).click();
  await expect(page.getByRole('button', { name: 'draw.io' })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvasContent).toHaveAttribute('data-scale', '1');
  await expect(page.getByRole('img', { name: 'draw.io model preview' })).toBeVisible();
  await page.getByText(/Canonical JSON/u).click();
  await expect(page.locator('pre').filter({ hasText: 'Insurance Claim' })).toBeVisible();

  await page.getByLabel('Message the model assistant').fill('Add recovery transactions.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('I added recovery transactions and updated the model definition.')).toBeVisible();
  await expect(page.getByLabel('Canonical model business definition')).toHaveValue('Tracks claims, payments and recovery transactions.');

  const buttonTypography = await page.locator('.app-shell button').evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button);
    return `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`;
  }));
  expect([...new Set(buttonTypography)]).toEqual([buttonTypography[0]]);

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('Version 1')).toBeVisible();
  const mermaidLink = page.getByRole('link', { name: 'Download Mermaid v1' });
  const drawioLink = page.getByRole('link', { name: 'Download draw.io v1' });
  await expect(mermaidLink).toHaveAttribute('href', /version=1/u);
  await expect(drawioLink).toHaveAttribute('href', /version=1/u);
  await expect(mermaidLink).toHaveAttribute('download', 'claim-payment-v1.mmd');
  await expect(drawioLink).toHaveAttribute('download', 'claim-payment-v1.drawio');

  await page.getByRole('button', { name: 'Open as draft' }).click();
  await expect(page.getByText('Version 1 opened as working draft')).toBeVisible();
  await expect(page.locator('.project-item').filter({ hasText: 'Claim Payment' })).toContainText('1 version');
  await page.screenshot({ path: 'test-results/claim-payment-workflow.png', fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/claim-payment-workflow-mobile.png', fullPage: true });
});
