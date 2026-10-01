export async function renderMermaidSvg(id: string, source: string) {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false });
  return mermaid.render(id, source);
}
