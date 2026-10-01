import { expect, test } from '@playwright/test';
import { generatedClaimPayment } from '../test/fixtures/claim-payment';

test('Michal can generate, refine, preview and version a claim payment model', async ({ page }) => {
  let generationCount = 0;
  let created = false;
  let firstChatRequirements = '';
  let providerSettings = { baseUrl: 'https://api.openai.com/v1', model: 'environment-model', providerType: 'openai' as const, apiKeyConfigured: true };
  const longClarificationQuestion = [
    'Should an external payment reference be unique?',
    ...Array.from({ length: 11 }, (_, index) => `Clarification context ${index + 1}: confirm the platform boundary.`),
  ].join('\n');
  const longClarificationAnswer = [
    'Yes, within the payment platform.',
    ...Array.from({ length: 11 }, (_, index) => `Answer detail ${index + 1}: preserve the audit trail.`),
  ].join('\n');
  const longHumanRequest = [
    'Add recovery transactions.',
    ...Array.from({ length: 11 }, (_, index) => `Requirement ${index + 1}: retain recovery provenance.`),
  ].join('\n');
  const longAssistantReply = [
    'I added recovery transactions and updated the model definition.',
    ...Array.from({ length: 12 }, (_, index) => `Review note ${index + 1}: recovery detail ${'x'.repeat(48)}`),
    `Reference: https://models.example/${'x'.repeat(600)}`,
  ].join('\n');
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
    providerSettings: { providerType: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'environment-model' },
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
    const ndjson = (events: unknown[]) => route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
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
    if (path.endsWith('/generation-jobs') && method === 'POST') {
      generationCount += 1;
      project.draft = generationCount === 1
        ? { ...structuredClone(generatedClaimPayment), warnings: ['Confirm whether external payment references must be unique.'], clarificationQuestions: [longClarificationQuestion] }
        : structuredClone(generatedClaimPayment);
      return json({
        id: `job-${generationCount}`, projectId: project.id, status: 'completed',
        providerSettings: project.providerSettings, phase: 'completed', message: 'Draft ready.', transcript: '{"model":',
        error: null, createdAt: '2026-09-22T00:00:00Z', startedAt: '2026-09-22T00:00:01Z',
        heartbeatAt: '2026-09-22T00:00:02Z', completedAt: '2026-09-22T00:00:03Z', updatedAt: '2026-09-22T00:00:03Z',
      }, 202);
    }
    if (path.endsWith('/generation-jobs') && method === 'GET') return route.fulfill({ status: 204 });
    if (path.endsWith('/draft') && method === 'PUT') {
      project.draft = request.postDataJSON() as typeof generatedClaimPayment;
      return json(project.draft);
    }
    if (path.endsWith('/chat') && method === 'POST') {
      const message = (request.postDataJSON() as { message: string }).message;
      const answeringQuestion = message.startsWith('Yes,');
      if (!firstChatRequirements) firstChatRequirements = project.requirements;
      await new Promise(resolve => setTimeout(resolve, 450));
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
          : longAssistantReply, createdAt: '2026-09-22T00:02:01Z' },
      ];
      return ndjson([
        { type: 'progress', progress: { phase: 'generating', message: 'Updating the model…' } },
        { type: 'result', project },
      ]);
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
  await page.route('**/api/settings/provider', async route => {
    if (route.request().method() === 'PUT') {
      providerSettings = { ...route.request().postDataJSON() as typeof providerSettings, apiKeyConfigured: true };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(providerSettings) });
  });
  await page.route('**/api/settings/provider/models**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: providerSettings.model, name: providerSettings.model }]),
  }));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Turn complex requirements/u })).toBeVisible();
  await expect(page.getByText(/Generate sends the supplied material to the configured provider/u)).toBeVisible();
  await expect(page.getByText('Data Model Design Space')).toBeVisible();
  await page.getByRole('button', { name: 'Provider settings' }).click();
  await expect(page.getByRole('heading', { name: 'Provider settings' })).toBeVisible();
  await page.getByLabel('Provider base URL').fill('https://models.example/v1');
  await page.getByLabel('Provider model').fill('claims-model');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.getByRole('button', { name: 'Return home to Model Foundry' }).click();
  await expect(page.getByRole('heading', { name: 'Start with what you know' })).toBeVisible();

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
  await expect(page.getByRole('region', { name: 'Model chat' })).toHaveCount(0);
  await page.getByRole('button', { name: /Open model assistant/u }).click();
  await expect(page.getByRole('region', { name: 'Model chat' })).toBeVisible();
  const assumptionsCard = page.locator('details.assumptions-card');
  const warningsCard = page.locator('details.warnings-card');
  await expect(assumptionsCard).not.toHaveAttribute('open', '');
  await expect(warningsCard).not.toHaveAttribute('open', '');
  await assumptionsCard.locator('summary').click();
  await expect(page.getByText('A claim uses one currency for approval and payments.')).toBeVisible();
  await expect(page.getByText(/Should an external payment reference be unique\?/u)).toBeVisible();
  await expect(page.locator('.mermaid-preview svg')).toBeVisible();
  const liveOutput = page.getByRole('region', { name: 'Live model output' });
  const outputWidthBeforeCollapse = (await liveOutput.boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse workspace sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand workspace sidebar' })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await liveOutput.boundingBox())!.width).toBeGreaterThan(outputWidthBeforeCollapse);
  const modelCanvas = page.getByRole('group', { name: 'Interactive model canvas' });
  const canvasContent = modelCanvas.locator('.model-canvas-content');
  await expect(canvasContent).toHaveAttribute('data-scale', '0.5');
  const canvasBox = await modelCanvas.boundingBox();
  expect(canvasBox).toBeTruthy();
  expect(canvasBox!.height).toBeGreaterThanOrEqual(540);
  const scrollBeforeZoom = await page.evaluate(() => window.scrollY);
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.wheel(0, -420);
  await expect.poll(async () => Number(await canvasContent.getAttribute('data-scale'))).toBeGreaterThan(.5);
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
  await expect(canvasContent).toHaveAttribute('data-scale', '0.5');
  await expect(canvasContent).toHaveAttribute('data-offset-x', '0');
  await expect(canvasContent).toHaveAttribute('data-offset-y', '0');
  const mermaidSvg = page.locator('.mermaid-preview svg');
  expect(await mermaidSvg.getAttribute('width')).not.toBe('100%');
  expect(await canvasContent.evaluate(element => getComputedStyle(element).willChange)).toBe('auto');
  const widthAtFifty = (await mermaidSvg.boundingBox())!.width;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(canvasContent).toHaveAttribute('data-scale', '1');
  await expect.poll(async () => (await mermaidSvg.boundingBox())!.width).toBeCloseTo(widthAtFifty * 2, -1);
  await page.getByRole('button', { name: 'Reset model view' }).click();
  const entityEditors = page.locator('details.entity-editor');
  const entitiesEditor = page.locator('details.entities-editor');
  await expect(entitiesEditor).not.toHaveAttribute('open', '');
  await expect(entityEditors).toHaveCount(2);
  await expect(entityEditors.nth(0)).not.toHaveAttribute('open', '');
  await expect(entityEditors.nth(1)).not.toHaveAttribute('open', '');
  await expect(page.locator('details.relationship-editor')).not.toHaveAttribute('open', '');
  await expect(page.locator('details.rule-editor')).not.toHaveAttribute('open', '');
  await expect(page.locator('details.history-card')).not.toHaveAttribute('open', '');
  await entitiesEditor.locator('summary').first().click();
  await entityEditors.nth(0).locator('summary').click();
  await expect(page.getByLabel('Entity name Claim')).toBeVisible();

  const chat = page.getByRole('region', { name: 'Model chat' });
  const editor = page.getByRole('region', { name: 'Structured model editor' });
  const review = page.getByRole('region', { name: 'Assumptions and warnings' });
  const outputBox = await liveOutput.boundingBox();
  const chatBox = await chat.boundingBox();
  const editorBox = await editor.boundingBox();
  const reviewBox = await review.boundingBox();
  expect(outputBox && chatBox && chatBox.x >= outputBox.x && chatBox.x + chatBox.width <= outputBox.x + outputBox.width + 1).toBeTruthy();
  expect(outputBox && chatBox && chatBox.y >= outputBox.y).toBeTruthy();
  expect(outputBox && editorBox && editorBox.y >= outputBox.y + outputBox.height - 1).toBeTruthy();
  expect(editorBox && reviewBox && reviewBox.y >= editorBox.y + editorBox.height - 1).toBeTruthy();

  const clarificationMessage = page.locator('.chat-message.clarification-prompt');
  const clarificationBody = clarificationMessage.locator('.chat-message-body');
  await expect.poll(async () => clarificationBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await clarificationBody.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await clarificationBody.evaluate(element => element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(10, 1);
  await expect.poll(async () => (await clarificationMessage.boundingBox())!.height).toBeGreaterThan(200);

  await expect(page.getByLabel('Persistent model instructions')).toHaveValue('Model claim payments for a large insurance organisation.');
  await page.getByLabel('Persistent model instructions').fill('Model claim payments with a complete auditable payment history.');

  await page.getByLabel('Message the model assistant').fill(longClarificationAnswer);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.chat-message.user.pending .chat-message-body')).toContainText('Yes, within the payment platform.');
  await expect(page.locator('.chat-message.thinking')).toBeVisible();
  await expect(page.locator('.thinking-dots i')).toHaveCount(3);
  expect(await page.locator('.chat-message.thinking').evaluate(element => getComputedStyle(element).animationName)).not.toBe('none');
  expect(await page.locator('.thinking-dots i').first().evaluate(element => getComputedStyle(element).animationName)).not.toBe('none');
  await expect(page.getByLabel('Message the model assistant')).toBeEnabled();
  await page.getByLabel('Message the model assistant').fill('Draft the next request.');
  await expect(page.getByText('I applied the uniqueness requirement and cleared the question.')).toBeVisible();
  expect(firstChatRequirements).toBe('Model claim payments with a complete auditable payment history.');
  await expect(page.getByText('Thinking...')).toHaveCount(0);
  await expect(page.getByLabel('Message the model assistant')).toHaveValue('Draft the next request.');
  await expect(page.locator('.chat-message.clarification-prompt')).toHaveCount(0);
  await expect(page.getByLabel('Canonical model business definition')).toHaveValue('Tracks claim payments with unique platform references.');
  const clarificationAnswer = page.locator('.chat-message.user').first();
  const clarificationAnswerBody = clarificationAnswer.locator('.chat-message-body');
  await expect.poll(async () => clarificationAnswerBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await clarificationAnswerBody.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await clarificationAnswerBody.evaluate(element => element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(10, 1);
  await expect.poll(async () => (await clarificationAnswer.boundingBox())!.height).toBeGreaterThan(200);

  const entityName = page.getByLabel('Entity name Claim');
  await entityName.fill('Insurance Claim');
  await expect(page.getByText('Draft saved')).toBeVisible();

  await page.getByRole('button', { name: 'draw.io' }).click();
  await expect(page.getByRole('button', { name: 'draw.io' })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvasContent).toHaveAttribute('data-scale', '0.5');
  await expect(page.getByRole('img', { name: 'draw.io model preview' })).toBeVisible();
  await page.getByText(/Canonical JSON/u).click();
  await expect(page.locator('pre').filter({ hasText: 'Insurance Claim' })).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('Message the model assistant').fill(longHumanRequest);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.chat-message.thinking')).toBeVisible();
  expect(await page.locator('.chat-message.thinking').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.locator('.thinking-dots i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.getByText(/I added recovery transactions and updated the model definition/u)).toBeVisible();
  await expect(page.getByLabel('Canonical model business definition')).toHaveValue('Tracks claims, payments and recovery transactions.');
  const latestUserMessage = page.locator('.chat-message.user').last();
  const latestUserBody = latestUserMessage.locator('.chat-message-body');
  const latestAssistantMessage = page.locator('.chat-message.assistant').last();
  const latestAssistantBody = latestAssistantMessage.locator('.chat-message-body');
  await expect.poll(async () => latestUserBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => latestAssistantBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await latestUserBody.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await latestAssistantBody.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await latestUserBody.evaluate(element => element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(10, 1);
  expect(await latestAssistantBody.evaluate(element => element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(10, 1);
  await expect.poll(async () => (await latestUserMessage.boundingBox())!.height).toBeGreaterThan(200);
  await expect.poll(async () => (await latestAssistantMessage.boundingBox())!.height).toBeGreaterThan(200);
  const transcript = page.locator('.chat-transcript');
  expect(await transcript.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  await expect.poll(async () => transcript.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => transcript.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => {
    const messageBox = await latestAssistantMessage.boundingBox(), currentChatBox = await chat.boundingBox();
    return Boolean(messageBox && currentChatBox && messageBox.x + messageBox.width <= currentChatBox.x + currentChatBox.width + 1);
  }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const buttonTypography = await page.locator('.app-shell button').evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button);
    return `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`;
  }));
  expect([...new Set(buttonTypography)]).toEqual([buttonTypography[0]]);

  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByText('Version history').click();
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
