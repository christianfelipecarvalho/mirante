# Working on Mirante

Mirante is a local dashboard for observing coding agents. Preserve its event
contract, offline operation, loopback-only API, redaction, and English/Portuguese
translations. Keep external fonts, CDN assets, analytics, and outbound requests
out of the application.

## Frontend design

Use the project-local [Impeccable skill](.agents/skills/impeccable/SKILL.md) for
interface analysis, visual changes, accessibility, responsive layout, and motion.
Read its instructions and the references relevant to the task. Run its `context`
command once per session from the repository root:

```bash
sh .agents/skills/impeccable/scripts/impeccable context --target apps/web/src/App.tsx
```

The existing components, CSS tokens, and logo are the design authority. For
refinements, preserve the identity and workflows and follow the `quieter`,
`animate`, and `operate` guidance as applicable. Read `craft-floor.md` before UI
edits. Keep status colors paired with labels/icons, support both themes, and
respect reduced motion. The logo returns to the board's home view.

Active agents keep a clearly colored frame and a slow travelling light in their
own color. This is a functional activity signal requested by the user: preserve
it while work continues, keep inactive cards neutral, and distinguish waiting
with amber. Reduced motion retains the colored frame without movement. Hover
feedback must remain separate from the active/inactive state.
Use the user's current VS Code theme, GitHub Dark Default, as the color
reference: blue-tinted graphite surfaces, a clear blue accent, expressive
agent/icon colors, and a visible glow that follows the mouse.
Apply this activity treatment to both board cards and nodes inside the agent
canvas. Canvas nodes also keep a lit surface while working and a neutral surface
while idle, finished, or silent; retain their readable status badges.
Keep the main agent centered in the radial canvas and preserve observed parent
connections. Hide inactive agents through a reversible control, keeping the
main, agents requiring attention, and ancestors of visible branches. Compute
positions before filtering so lifecycle changes do not move the remaining
cards; respect manual scrolling and provide a way to center the main again.

After the implementation, inspect desktop and mobile together, check keyboard
navigation and both themes, and run the design detector over changed UI files:

```bash
sh .agents/skills/impeccable/scripts/impeccable detect --json apps/web/src
```

Review findings against the product's actual requirements. Fix contrast,
overflow, inaccessible controls, and unnecessary motion; do not suppress rules
to make a report look clean. Vendored skill files retain their upstream content
and are excluded from the application's formatting and linting.

## Validation

Use Node.js 22.13+ and the pnpm version declared in `package.json`.
Run `pnpm check` and `pnpm build` before handing off a substantive change. Tests
that exercise local HTTP/WebSocket servers require permission to bind loopback
ports in restricted environments. Preview with synthetic data when possible.
