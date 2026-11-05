import { createUndoAction } from "@excalidraw/excalidraw/actions/actionHistory";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { clear, createStore } from "idb-keyval";
import { vi } from "vitest";

import ExcalidrawApp from "../App";
import { appJotaiStore } from "../app-jotai";
import { isCollaboratingAtom, isOfflineAtom } from "../collab/Collab";
import { refreshSceneIndex } from "../scenes/sceneManager";
import { getSceneIndex } from "../scenes/sceneStore";

const { h } = window;

vi.mock("../../excalidraw-app/data/firebase.ts", () => ({
  loadFromFirebase: async () => null,
  saveToFirebase: () => {},
  isSavedToFirebase: () => true,
  loadFilesFromFirebase: async () => ({ loadedFiles: [], erroredFiles: [] }),
  saveFilesToFirebase: async () => ({
    savedFiles: new Map(),
    erroredFiles: new Map(),
  }),
}));

vi.mock("socket.io-client", () => ({
  default: () => ({
    close: () => {},
    on: () => {},
    once: () => {},
    off: () => {},
    emit: () => {},
  }),
}));

const scenesStore = createStore("excalidraw-scenes-db", "scenes-store");

const trigger = () => screen.getByTestId("scene-switcher-trigger");

const openMenu = () => {
  if (!screen.queryByTestId("scene-switcher-new")) {
    fireEvent.click(trigger());
  }
};

const activeSceneId = () => getSceneIndex().activeSceneId;

const addRect = (id: string) => {
  act(() => {
    API.updateScene({
      elements: [...h.elements, API.createElement({ type: "rectangle", id })],
    });
  });
};

const elementIds = () => h.elements.map((element) => element.id);

const createSceneFromMenu = async () => {
  const before = activeSceneId();
  openMenu();
  fireEvent.click(screen.getByTestId("scene-switcher-new"));
  await waitFor(() => {
    expect(activeSceneId()).not.toBe(before);
    expect(h.state.isLoading).toBe(false);
  });
};

const switchFromMenu = async (id: string) => {
  openMenu();
  fireEvent.click(screen.getByTestId(`scene-switcher-item-${id}`));
  await waitFor(() => {
    expect(activeSceneId()).toBe(id);
    expect(h.state.isLoading).toBe(false);
  });
};

describe("multi-scene", () => {
  let unmount: () => void;

  beforeEach(async () => {
    localStorage.clear();
    await clear(scenesStore);
    refreshSceneIndex();
    appJotaiStore.set(isCollaboratingAtom, false);
    appJotaiStore.set(isOfflineAtom, false);
    ({ unmount } = await render(<ExcalidrawApp />));
  });

  it("shows the active scene's name in the dropdown trigger", () => {
    expect(trigger().textContent).toContain("Scene 1");
  });

  it("keeps elements, scroll and background separate per scene", async () => {
    const firstId = activeSceneId();
    addRect("first");
    act(() => {
      API.setAppState({ scrollX: 75, viewBackgroundColor: "#ffc9c9" });
    });

    await createSceneFromMenu();
    expect(elementIds()).toEqual([]);
    expect(h.state.scrollX).toBe(0);
    expect(h.state.viewBackgroundColor).not.toBe("#ffc9c9");
    expect(trigger().textContent).toContain("Scene 2");

    addRect("second");
    const secondId = activeSceneId();

    await switchFromMenu(firstId);
    expect(elementIds()).toEqual(["first"]);
    expect(h.state.scrollX).toBe(75);
    expect(h.state.viewBackgroundColor).toBe("#ffc9c9");

    await switchFromMenu(secondId);
    expect(elementIds()).toEqual(["second"]);
  });

  it("doesn't change the theme when switching", async () => {
    act(() => {
      API.setAppState({ theme: "dark" });
    });
    await createSceneFromMenu();
    expect(h.state.theme).toBe("dark");
  });

  it("undo after a switch doesn't touch the new scene", async () => {
    const firstId = activeSceneId();
    addRect("first");
    await createSceneFromMenu();
    await switchFromMenu(firstId);

    const undo = createUndoAction(h.history);
    act(() => {
      h.app.actionManager.executeAction(undo);
    });

    expect(elementIds()).toEqual(["first"]);
    expect(h.history.isUndoStackEmpty).toBe(true);
  });

  it("keeps the active scene across a remount", async () => {
    addRect("first");
    await createSceneFromMenu();
    const secondId = activeSceneId();
    addRect("second");

    // force the debounced save, as happens on unload
    window.dispatchEvent(new Event("blur"));
    unmount();
    await render(<ExcalidrawApp />);

    await waitFor(() => {
      expect(activeSceneId()).toBe(secondId);
      expect(trigger().textContent).toContain("Scene 2");
      expect(elementIds()).toEqual(["second"]);
    });
  });

  it("renames a scene from the dropdown", async () => {
    const id = activeSceneId();
    openMenu();
    fireEvent.click(screen.getByTestId(`scene-switcher-rename-${id}`));

    const input = screen.getByTestId("scene-switcher-rename-input");
    fireEvent.change(input, { target: { value: "Plans" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(trigger().textContent).toContain("Plans");
    });
    expect(h.state.name).toBe("Plans");
  });

  it("closes the menu while renaming, so it can't take focus from the field", () => {
    const id = activeSceneId();
    openMenu();
    fireEvent.click(screen.getByTestId(`scene-switcher-rename-${id}`));

    expect(screen.getByTestId("scene-switcher-rename-input")).toBeTruthy();
    expect(screen.queryByTestId("scene-switcher-new")).toBeNull();
  });

  it("focuses the rename field, so typing doesn't trigger canvas shortcuts", async () => {
    const id = activeSceneId();
    openMenu();
    fireEvent.click(screen.getByTestId(`scene-switcher-rename-${id}`));
    const input = screen.getByTestId("scene-switcher-rename-input");

    // Dialog moves focus in a timeout after mounting, so wait past that
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(document.activeElement).toBe(input);
  });

  it("deletes a scene only after confirmation", async () => {
    const firstId = activeSceneId();
    addRect("first");
    await createSceneFromMenu();
    const secondId = activeSceneId();

    openMenu();
    fireEvent.click(screen.getByTestId(`scene-switcher-delete-${secondId}`));

    // cancelling keeps the scene
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getSceneIndex().scenes).toHaveLength(2);

    openMenu();
    fireEvent.click(screen.getByTestId(`scene-switcher-delete-${secondId}`));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(getSceneIndex().scenes.map((scene) => scene.id)).toEqual([
        firstId,
      ]);
      expect(elementIds()).toEqual(["first"]);
    });
  });

  it("has no delete button when only one scene exists", () => {
    openMenu();
    expect(
      screen.queryByTestId(`scene-switcher-delete-${activeSceneId()}`),
    ).toBeNull();
  });

  it("disables switching during collaboration", async () => {
    await act(async () => {
      appJotaiStore.set(isCollaboratingAtom, true);
    });

    await waitFor(() => {
      expect(trigger()).toHaveProperty("disabled", true);
    });
    fireEvent.click(trigger());
    expect(screen.queryByTestId("scene-switcher-new")).toBeNull();
  });

  it("still shows the dropdown when collaboration isn't available", async () => {
    await act(async () => {
      appJotaiStore.set(isOfflineAtom, true);
    });

    await waitFor(() => {
      expect(screen.queryByText("Share")).toBeNull();
    });
    expect(trigger()).toBeTruthy();
  });
});
