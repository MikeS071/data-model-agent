# Upstream provenance

- Project: UI/UX Pro Max
- Repository: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Upstream version: 2.13.0
- Reviewed commit: `dcc40ff5133ef78276117db0cc34e7b83cc8aeba`
- License: MIT; see `LICENSE.upstream`
- Copyright: Copyright (c) 2024 Next Level Builder

The skill instructions, local search scripts, references and catalog data were copied
from the reviewed upstream commit. dev-stack changed the runtime paths from a
Claude-specific plugin root to the installed project-local `.governance` path, requires
the supported `python3` command, and tightened routing text so the skill is selected only
for visual or interactive UI/UX work. No upstream test suite or generated Python cache is
included in the release.
