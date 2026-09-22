# Data Model Agent UI design system

This project-local design system was generated with UI/UX Pro Max 2.13.0 and then
fit-checked against the accepted single-user insurance modelling workflow. The broad
catalog's marketing hero pattern was rejected because this is an operational workbench,
not a conversion page. The retained direction combines its enterprise palette and
typography guidance with the matched Data-Dense Dashboard and Minimalism & Swiss styles.

## Product character

- Trustworthy, precise and calm rather than decorative.
- Dense enough for professional model editing, but progressively disclosed.
- One obvious primary action per state.
- Visual hierarchy comes from spacing, type, borders and semantic surfaces—not gradients,
  oversized marketing copy or ornamental effects.
- Desktop supports sustained modelling work; tablet and mobile remain usable without
  horizontal page scrolling.

## Layout

- Use a compact product header for identity, pilot status and current save state.
- At desktop widths, keep the 240px model navigation and use the flexible work area for a
  two-column collaboration row: live model output in the main column and chat beside it.
- Keep the current model title and version actions visible at the top of the work area.
- Treat the next clarification as a guided assistant message in chat; its answer updates
  the same canonical model as any other conversational change.
- Put the full-width structured editor below the live-output/chat row, followed by version
  history, with assumptions and warnings as the final review section.
- Collapse entity detail behind accessible summaries; show identity and field counts when
  collapsed. Relationships and rules remain separate, clearly titled editor groups.
- Below 1100px, stack live output, chat, editor, history and review in that reading order.
  Below 760px, turn model navigation into a normal flow section and use single-column
  form rows.

## Semantic color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--color-primary` | `#0369A1` | Primary actions, active state, focus relationship |
| `--color-primary-strong` | `#075985` | Primary hover/pressed state |
| `--color-on-primary` | `#FFFFFF` | Text/icons on primary |
| `--color-accent` | `#15803D` | Successful/safe state only |
| `--color-background` | `#EEF5F8` | Application background |
| `--color-surface` | `#FFFFFF` | Main panels and controls |
| `--color-surface-subtle` | `#F7FAFC` | Grouping and editor rows |
| `--color-foreground` | `#132B3A` | Primary text |
| `--color-muted-foreground` | `#526673` | Secondary text |
| `--color-border` | `#C8D8E1` | Separators and control boundaries |
| `--color-warning` | `#9A5B13` | Warning labels and borders |
| `--color-warning-surface` | `#FFF7E8` | Warning background |
| `--color-danger` | `#B42318` | Destructive/error state |
| `--color-ring` | `#0284C7` | Keyboard focus ring |

Normal text must meet 4.5:1 contrast. Controls, status and relationships must never rely
on color alone.

## Typography and spacing

- Prefer IBM Plex Sans when locally available, then `Aptos`, `Segoe UI`, and system
  sans-serif fallbacks. Do not add a runtime Google Fonts request to this sensitive pilot.
- Use 16px base body text and 1.5 line-height; compact metadata may use 12–13px with strong
  contrast.
- Use a 4/8px spacing rhythm: 4, 8, 12, 16, 24, 32 and 48px.
- Page title: 28–34px/1.15. Section title: 18–22px/1.25. Body: 14–16px/1.5.
- Keep readable copy to roughly 65–75 characters per line.

## Components and interaction

- Controls use 8px corners; grouping panels use 12px corners. Avoid excessive pill shapes.
- Buttons have a minimum 40px height on desktop and 44px on compact/touch layouts.
- Every button inherits the application typeface and uses the same 14px size, 700 weight,
  8px radius and focus treatment. Primary, secondary, text and danger variants may change
  fill, border and emphasis, but not typography.
- Every input has a persistent visible label. Placeholder text is supplementary only.
- Primary actions show disabled, busy, success and error state through text and semantics.
- Use native buttons, links, inputs, selects, details/summary and fieldsets.
- Icon-only controls use one inline outline SVG family and an accessible name.
- Use `aria-live` for save/generation state. Error alerts remain inline and keyboard
  discoverable.
- Segmented preview controls expose `aria-pressed`.
- Mermaid and draw.io share one clipped interactive canvas. Wheel input zooms around the
  pointer and primary mouse-button drag pans the model; bound zoom to a useful range and show a
  compact percentage, zoom-in, zoom-out and reset toolbar. The canvas is focusable and
  supports arrow-key panning plus `+`, `-` and `0` so drag is never the only interaction.
- Use a `grab` cursor at rest and `grabbing` while panning, suppress text selection during
  a drag, and reset the viewport when the representation changes.
- Hover and focus transitions use 150–200ms. Never move layout on hover.

## Motion

Use motion only to explain state: panel disclosure, hover/focus and save feedback. Avoid
scroll-reveal choreography in the workbench. Under `prefers-reduced-motion: reduce`, make
transitions effectively immediate.

## Pre-delivery checks

- [ ] Keyboard order matches visual order and all controls have visible focus.
- [ ] Labels, error messages and live status are announced.
- [ ] No emoji or font glyph is used as a structural icon.
- [ ] No content is hidden behind sticky UI.
- [ ] No horizontal page scroll at 375, 768, 1024 or 1440px.
- [ ] Primary, warning, error and selected states remain distinguishable without color.
- [ ] Empty, loading, disabled, success and failure states are visible.
- [ ] Mermaid, draw.io, versioning, downloads and canonical JSON remain accessible.
- [ ] Visualization zoom/pan works with mouse, controls and keyboard without moving the
  surrounding page or creating page-level overflow.
