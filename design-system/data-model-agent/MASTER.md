# Data Model Agent UI design system

The application uses the AustralianSuper `AS Theme 2023` identity from the approved
AustralianSuper PowerPoint template. The compact application header retains the product
name at left and displays the approved full AustralianSuper purple/orange wordmark at right.

UI/UX Pro Max selects **Data-Dense Dashboard** as the product pattern. Apply it with
AustralianSuper's approved custom tints rather than the skill's generic blue dashboard
palette: soft neutral framing, compact information hierarchy, progressive disclosure,
restrained elevation and pastel brand surfaces. Reserve full-strength purple/orange for
the official logo, keyboard focus and small interaction accents; avoid large saturated
blocks or high-contrast decorative treatments.

Impeccable 4.1.0 at reviewed commit `0d6b47e` classifies the workbench as an **Operate** surface. Polish preserves the
AustralianSuper visual world while making the tool disappear into the modelling task:
one elevation mechanism per panel, no repeated eyebrow labels, no decorative card stripes,
no nested-card treatment for editor sections, fixed product typography, one obvious
primary action, and a compact sticky assistant beside the larger model workspace.

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
- At desktop widths, use a 240px collapsible model-navigation sidebar and a 72px labelled
  icon rail when collapsed. Give the recovered width to the work area and favor the live
  model output over chat in the expanded collaboration row.
- Keep Home/New model, Settings and collapse actions keyboard operable and visibly focused.
  On narrow screens use the full-width menu rather than an ambiguous icon-only rail.
- Keep the current model title and version actions visible at the top of the work area.
- Treat the next clarification as a guided assistant message in chat; its answer updates
  the same canonical model as any other conversational change.
- Keep the original requirements available in the working draft as an editable
  `Persistent model instructions` field. Make its saved state and effect explicit: it
  grounds every later regeneration and assistant turn but editing it alone makes no
  provider call.
- Put the full-width structured editor below the live-output/chat row, followed by version
  history, with assumptions and warnings as the final review section.
- Collapse every entity, relationships, validation rules and version history initially
  behind native accessible summaries. Show names and item counts while collapsed so the
  workbench stays scannable without hiding what each disclosure contains.
- Below 1100px, stack live output, chat, editor, history and review in that reading order.
  Below 760px, turn model navigation into a normal flow section and use single-column
  form rows.

## Semantic color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--color-primary` | `#7D6690` | Approved muted-purple primary controls |
| `--color-primary-strong` | `#51336B` | Deep-lavender headings and hover state |
| `--color-on-primary` | `#FFFFFF` | Text/icons on primary |
| `--color-accent` | `#FA8C00` | Approved soft-orange decorative and progress accents |
| `--color-accent-strong` | `#8C2902` | Accessible dark-orange labels and relationships |
| `--color-background` | `#F0F0F0` | Approved soft-grey application background |
| `--color-surface` | `#FFFFFF` | Main panels and controls |
| `--color-surface-subtle` | `#F0F0F0` | Grouping and editor rows |
| `--color-foreground` | `#2E2E2E` | Primary body text |
| `--color-muted-foreground` | `#606060` | Secondary text |
| `--color-border` | `#D4CCDA` | Approved pale-lavender separators |
| `--color-border-strong` | `#A899B5` | Approved lavender selected boundaries |
| `--color-highlight` | `#D4CCDA` | Approved pale-lavender selection surface |
| `--color-information` | `#EDE1B5` | Approved cream information/warning surface |
| `--color-danger-surface` | `#F7B49A` | Approved pastel-coral destructive/error surface |
| `--color-ring` | `#EA4403` | Orange keyboard focus ring |

Normal text must meet 4.5:1 contrast. Controls, status and relationships must never rely
on color alone.

## Typography and spacing

- Use Arial, matching the AustralianSuper theme's major and minor font. Fall back to
  `Helvetica Neue` and a generic sans-serif without adding a runtime font request.
- Use 16px base body text and 1.5 line-height; compact metadata may use 12–13px with strong
  contrast.
- Use a 4/8px spacing rhythm: 4, 8, 12, 16, 24, 32 and 48px.
- Page title: 28–34px/1.15. Section title: 18–22px/1.25. Body: 14–16px/1.5.
- Keep readable copy to roughly 65–75 characters per line.

## Components and interaction

- Controls use 8px corners; grouping panels use 12–16px corners. Avoid excessive pill shapes.
- Use either a border or a shadow to establish a surface, not both. Editor disclosures inside
  a panel are flat sections separated by rules; only repeated entity rows retain a bounded
  container because they are individually interactive records.
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
- The visualization defaults and resets to 50% and uses a taller desktop viewport. Chat
  bubbles have a shrinkable inline size and wrap long tokens with `overflow-wrap: anywhere`
  so generated text can never widen its panel.
- Keep the complete persisted chat transcript in a bounded vertical scroll region. Limit
  every human and assistant message body, including clarification questions and answers,
  to ten visible rendered lines and give longer turns their own vertical scroll without
  clipping or truncating text. Grid/list rows must retain their content height so the
  transcript itself develops real overflow; nested reply scrolling hands off to transcript
  scrolling at the reply boundary.
- A sent user message appears immediately as a transient bubble. Show one adjacent,
  screen-reader-announced `Thinking...` assistant bubble until the request settles. Keep
  the composer usable for drafting the next message, while preventing a second concurrent
  model mutation from racing the first.
- Make the thinking bubble visibly active with one restrained surface pulse and staggered
  dots. Animate only opacity and transforms and stop the animation under
  `prefers-reduced-motion`, leaving a static visible and announced status.
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
