# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project Structure

Excalidraw is a Yarn 1 workspaces monorepo:

- `packages/excalidraw/`: the React component library published as `@excalidraw/excalidraw`
- `packages/element/`: element model, geometry, binding, `Scene` and `Store`
- `packages/common/`, `packages/math/`, `packages/utils/`: shared helpers, geometry primitives and export utilities
- `packages/fractional-indexing/`, `packages/laser-pointer/`: small standalone libraries
- `excalidraw-app/`: the excalidraw.com app (collaboration, Firebase, PWA, local persistence)
- `examples/`: integration examples (Next.js, browser script)
- `dev-docs/`: Docusaurus docs site, with its own `yarn.lock`

Editor features belong in `packages/*`. App-only features belong in `excalidraw-app/`.

## Commands

```bash
yarn start                # Dev server, port 3001 (VITE_APP_PORT in .env.development)
yarn build                # Build the app
yarn build:packages       # Build all packages in dependency order

yarn test:app --watch=false                    # All tests (plain `yarn test` starts watch mode)
yarn test:app path/to/file.test.tsx --watch=false        # One file
yarn test:app path/to/file.test.tsx -t "name" --watch=false   # One test by name
yarn test:update          # All tests once, updating snapshots
yarn test:coverage        # Tests with coverage thresholds

yarn test:typecheck       # tsc
yarn test:code            # ESLint (--max-warnings=0)
yarn test:other           # Prettier check for css/scss/json/md/html/yml
yarn test:all             # Typecheck, ESLint, Prettier and tests
yarn fix                  # Auto-fix Prettier and ESLint issues
```

Run `yarn test:update` before committing and review the snapshot diff, since the command accepts every change. The pre-commit hook is disabled, so nothing runs lint locally. PR CI runs `test:other`, `test:code` and `test:typecheck`.

To see the full DOM in testing-library failures, run with `VITE_DEBUG_DOM=true`.

PR titles must be semantic and scoped, e.g. `fix(editor): ...`. CI allows the scopes `app`, `editor`, `packages/excalidraw`, `packages/utils`, `docker` and `repo`.

## Architecture

### Package boundaries

- Vite, Vitest and `tsconfig.json` all alias `@excalidraw/*` to package source, so the dev server and tests don't need a package build.
- Packages build with esbuild (`scripts/buildBase.js`, `scripts/buildPackage.js`). The app builds with Vite.
- `packages/common` and `packages/element` may import only types from `@excalidraw/excalidraw` (enforced by `packages/eslintrc.base.json`).
- Inside `packages/excalidraw`, non-test code must import modules directly, not through the `index.tsx` barrel (enforced by ESLint).
- Don't import `jotai` directly. Use `packages/excalidraw/editor-jotai.ts` or `excalidraw-app/app-jotai.ts`.

### Editor core

`packages/excalidraw/components/App.tsx` is a very large class component that owns the `Scene`, `Store`, `History`, `Renderer` and `ActionManager`, and handles pointer and keyboard input.

- **Elements:** elements are treated as immutable except through the mutation helpers, which bump `version` and `versionNonce`; collaboration depends on these. `mutateElement` does not trigger a re-render, so use `scene.mutateElement` when the UI must update, or `newElementWith` for a copy.
- **Actions:** user commands live in `packages/excalidraw/actions/` and are registered with `register()`. An action returns an `ActionResult`, which `ActionManager` passes to `App.syncActionResult`.
- **Undo:** every `ActionResult` declares `captureUpdate`, and this decides what enters the undo stack (`CaptureUpdateAction` in `packages/element/src/store.ts`):
  - `IMMEDIATELY`: most local updates
  - `EVENTUALLY`: steps of an async multi-step process
  - `NEVER`: remote updates and scene initialization
- **Rendering:** drawing is split across layered canvases in `components/canvases/`. `StaticCanvas` draws scene content (`renderer/staticScene.ts`), `InteractiveCanvas` draws selection and handles (`renderer/interactiveScene.ts`), and `NewElementCanvas` draws the element being created (`renderer/renderNewElementScene.ts`).

### Collaboration (app only)

`excalidraw-app/collab/Collab.tsx` and `Portal.tsx` manage the room and broadcasts. Incoming elements are merged by `reconcileElements` in `packages/excalidraw/data/reconcile.ts`. Payloads are end-to-end encrypted (`packages/excalidraw/data/encryption.ts`), and Firebase persistence is in `excalidraw-app/data/firebase.ts`. Running collaboration locally requires the separate `excalidraw-room` server.

### Tests

Vitest runs in jsdom with a mocked canvas (`setupTests.ts`). Editor tests render `<Excalidraw />` and drive it through the helpers in `packages/excalidraw/tests/helpers/` (`api.ts` for setup, `ui.ts` for input), reading state from `window.h`. `regressionTests.test.tsx` snapshots app state and render counts, so behavior changes can show up there as snapshot diffs.

## Conventions

- Math code uses the `Point` type from `packages/math/src/types.ts`, not `{ x, y }`.
- In hot paths, prefer implementations that avoid allocation, and trade RAM for fewer CPU cycles.
- Component styles are plain `.scss` files, not CSS modules.
- Translations: edit only `packages/excalidraw/locales/en.json`. Other locale files are managed through Crowdin.
