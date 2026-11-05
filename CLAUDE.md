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

## Fork Workflow

This is a personal fork. `upstream` is `excalidraw/excalidraw` and `origin` is the fork.

- `master` is a clean mirror of upstream. Never commit to it directly.
- `custom` holds all fork changes, and pushing to it deploys.
- New features branch from `custom` and merge back into it.

```bash
# Pull upstream changes
git fetch upstream
git switch master && git merge --ff-only upstream/master && git push origin master
git switch custom && git merge master   # resolve conflicts, run tests, then push to deploy

# Start a new feature
git switch -c feat/next-thing custom
```

Merge rather than rebase, because `custom` is pushed and shared.

## Deployment

A push to `custom` runs `.github/workflows/deploy-droplet.yml`: tests, then `yarn build:app:docker`, then a force-push of the output to the `deploy` branch, then SSH to the droplet. Don't use `yarn build` for this, because it enables tracking and Sentry reporting to Excalidraw's accounts.

The SSH key logs in as the non-root `deploy` user, which owns only `/var/www/draw` and `/opt/excalidraw-deploy.git`, and can only run `/usr/local/bin/excalidraw-deploy` (source: `scripts/droplet/excalidraw-deploy.sh`). That script checks out `deploy` into `/var/www/draw`, served at https://draw.jonaslodewegen.nl. Its git data is outside the web folder so it isn't publicly downloadable.

Changes to that script must be copied to the droplet by hand, keeping it owned by root. To run it manually, use `runuser -l deploy -c /usr/local/bin/excalidraw-deploy`, because running it as root would leave root-owned files the `deploy` user can't replace.

To roll back, revert the commit on `custom` and push.

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
