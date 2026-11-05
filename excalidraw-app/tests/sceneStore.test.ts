import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { clear, createStore, get, set } from "idb-keyval";
import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";
import { LocalData } from "../data/LocalData";
import {
  createScene,
  deleteScene,
  refreshSceneIndex,
  renameScene,
  switchScene,
} from "../scenes/sceneManager";
import {
  getAllSceneFileIds,
  getSceneIndex,
  loadStoredScene,
  saveStoredScene,
} from "../scenes/sceneStore";

const scenesStore = createStore("excalidraw-scenes-db", "scenes-store");
const filesStore = createStore("files-db", "files-store");

const rect = (id: string) => API.createElement({ type: "rectangle", id });

const imageElement = (id: string, fileId: string) =>
  API.createElement({ type: "image", id, fileId: fileId as FileId });

const storedElementIds = () =>
  JSON.parse(
    localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS) || "[]",
  ).map((element: { id: string }) => element.id);

/** Minimal stand-in for the editor API, tracking what the canvas holds. */
const createEditor = (
  initialElements: readonly any[] = [],
  initialAppState: Record<string, unknown> = {},
) => {
  const editor = {
    elements: [...initialElements] as readonly any[],
    appState: {
      ...getDefaultAppState(),
      ...initialAppState,
    } as Record<string, any>,
    files: {} as Record<string, any>,
    historyCleared: 0,
  };

  const api = {
    getSceneElementsIncludingDeleted: () => editor.elements,
    getAppState: () => editor.appState,
    getFiles: () => editor.files,
    updateScene: (scene: { elements?: readonly any[]; appState?: any }) => {
      if (scene.elements) {
        editor.elements = scene.elements;
      }
      if (scene.appState) {
        editor.appState = { ...editor.appState, ...scene.appState };
      }
    },
    addFiles: (files: { id: string }[]) => {
      for (const file of files) {
        editor.files[file.id] = file;
      }
    },
    history: {
      clear: () => {
        editor.historyCleared++;
      },
    },
  } as unknown as ExcalidrawImperativeAPI;

  return { editor, api };
};

describe("multi-scene storage", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    await clear(scenesStore);
    await clear(filesStore);
    refreshSceneIndex();
  });

  describe("first run", () => {
    it("turns the existing drawing into 'Scene 1' without touching its data", () => {
      const elements = JSON.stringify([rect("existing")]);
      const appState = JSON.stringify({ viewBackgroundColor: "#ffc9c9" });
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, elements);
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, appState);

      const index = getSceneIndex();

      expect(index.scenes.map((scene) => scene.name)).toEqual(["Scene 1"]);
      expect(index.activeSceneId).toBe(index.scenes[0].id);
      expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
        elements,
      );
      expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE)).toBe(
        appState,
      );
    });

    it("returns the same scene on repeated reads", () => {
      expect(getSceneIndex().activeSceneId).toBe(getSceneIndex().activeSceneId);
    });

    it("recovers from a corrupted scene list", () => {
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_SCENES, "{not json");
      expect(getSceneIndex().scenes).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("stores the current scene and switches to an empty one", async () => {
      const { editor, api } = createEditor([rect("a")]);
      const firstId = getSceneIndex().activeSceneId;

      const created = await createScene(api);

      const index = getSceneIndex();
      expect(created.name).toBe("Scene 2");
      expect(index.activeSceneId).toBe(created.id);
      expect(editor.elements).toEqual([]);
      expect(storedElementIds()).toEqual([]);
      expect(
        (await loadStoredScene(firstId))?.elements.map((el) => el.id),
      ).toEqual(["a"]);
    });

    it("doesn't reuse a default name that's already taken", async () => {
      const { api } = createEditor();
      await createScene(api);
      await renameScene(api, getSceneIndex().activeSceneId, "Scene 3");

      expect((await createScene(api)).name).toBe("Scene 4");
    });

    it("rejects an empty name", async () => {
      const { api } = createEditor();
      await expect(createScene(api, "   ")).rejects.toThrow();
      expect(getSceneIndex().scenes).toHaveLength(1);
    });
  });

  describe("switch", () => {
    it("round-trips elements and appState through storage", async () => {
      const { editor, api } = createEditor([rect("a")], {
        scrollX: 120,
        viewBackgroundColor: "#ffc9c9",
      });
      const firstId = getSceneIndex().activeSceneId;
      await createScene(api);

      editor.elements = [rect("b")];
      await switchScene(api, firstId);

      expect(editor.elements.map((el) => el.id)).toEqual(["a"]);
      expect(editor.appState.scrollX).toBe(120);
      expect(editor.appState.viewBackgroundColor).toBe("#ffc9c9");
      expect(storedElementIds()).toEqual(["a"]);
    });

    it("keeps the current theme", async () => {
      const { editor, api } = createEditor([], { theme: "light" });
      const firstId = getSceneIndex().activeSceneId;
      await createScene(api);

      editor.appState.theme = "dark";
      await switchScene(api, firstId);

      expect(editor.appState.theme).toBe("dark");
    });

    it("clears history on every switch", async () => {
      const { editor, api } = createEditor();
      const firstId = getSceneIndex().activeSceneId;
      await createScene(api);
      expect(editor.historyCleared).toBe(1);

      await switchScene(api, firstId);
      expect(editor.historyCleared).toBe(2);
    });

    it("copies the scene name to appState.name", async () => {
      const { editor, api } = createEditor();
      const created = await createScene(api, "Roadmap");

      expect(created.name).toBe("Roadmap");
      expect(editor.appState.name).toBe("Roadmap");
    });

    it("clears isLoading once finished", async () => {
      const { editor, api } = createEditor();
      await createScene(api);
      expect(editor.appState.isLoading).toBe(false);
    });

    it("leaves saving resumed afterwards", async () => {
      const { api } = createEditor();
      await createScene(api);
      expect(LocalData.isSavePaused()).toBe(false);
    });

    it("loads the target scene's images", async () => {
      const { editor, api } = createEditor([imageElement("img", "file-1")]);
      const firstId = getSceneIndex().activeSceneId;
      const file = { id: "file-1", dataURL: "data:image/png;base64,AA==" };
      await set("file-1", file, filesStore);
      await createScene(api);
      expect(editor.files["file-1"]).toBeUndefined();

      await switchScene(api, firstId);

      expect(editor.elements.map((el) => el.id)).toEqual(["img"]);
      expect(editor.files["file-1"]?.dataURL).toBe(file.dataURL);
    });

    it("ignores a second switch while one is in progress", async () => {
      const { api } = createEditor();
      const firstId = getSceneIndex().activeSceneId;
      const created = await createScene(api);

      const results = await Promise.allSettled([
        switchScene(api, firstId),
        switchScene(api, created.id),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(getSceneIndex().activeSceneId).toBe(firstId);
    });

    it("refuses to switch when another tab changed the active scene", async () => {
      const { editor, api } = createEditor([rect("mine")]);
      const firstId = getSceneIndex().activeSceneId;
      const created = await createScene(api);
      await switchScene(api, firstId);

      // another tab moves to the second scene, and this tab hasn't synced yet
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_SCENES,
        JSON.stringify({ ...getSceneIndex(), activeSceneId: created.id }),
      );

      await expect(switchScene(api, created.id)).rejects.toThrow();
      // this tab's canvas must not be written over the other tab's scene
      expect(await loadStoredScene(created.id)).toBeTruthy();
      expect(
        (await loadStoredScene(created.id))?.elements.map((el) => el.id),
      ).not.toContain("mine");
      expect(editor.elements.map((el) => el.id)).toEqual(["mine"]);
    });
  });

  describe("failed writes", () => {
    const setUpTwoScenes = async () => {
      const context = createEditor([rect("a")]);
      const firstId = getSceneIndex().activeSceneId;
      const second = await createScene(context.api);
      context.editor.elements = [rect("b")];
      await switchScene(context.api, firstId);
      return { ...context, firstId, secondId: second.id };
    };

    it("aborts and changes nothing when localStorage is full", async () => {
      const { editor, api, firstId, secondId } = await setUpTwoScenes();
      const elementsBefore = localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      );

      const realSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
        if (key === STORAGE_KEYS.LOCAL_STORAGE_APP_STATE) {
          throw new DOMException("full", "QuotaExceededError");
        }
        realSetItem(key, value);
      });

      await expect(switchScene(api, secondId)).rejects.toThrow();
      vi.restoreAllMocks();

      expect(getSceneIndex().activeSceneId).toBe(firstId);
      expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
        elementsBefore,
      );
      expect(editor.elements.map((el) => el.id)).toEqual(["a"]);
      expect(editor.appState.isLoading).toBe(false);
      expect(LocalData.isSavePaused()).toBe(false);
    });

    it("aborts when the target scene's data is missing", async () => {
      const { editor, api, firstId, secondId } = await setUpTwoScenes();
      await clear(scenesStore);

      await expect(switchScene(api, secondId)).rejects.toThrow();

      expect(getSceneIndex().activeSceneId).toBe(firstId);
      expect(editor.elements.map((el) => el.id)).toEqual(["a"]);
      expect(editor.appState.isLoading).toBe(false);
    });

    it("allows another switch after a failed one", async () => {
      const { editor, api, secondId } = await setUpTwoScenes();
      const stored = await loadStoredScene(secondId);
      await clear(scenesStore);
      await expect(switchScene(api, secondId)).rejects.toThrow();

      await saveStoredScene(secondId, stored!);
      await switchScene(api, secondId);

      expect(editor.elements.map((el) => el.id)).toEqual(["b"]);
    });
  });

  describe("rename", () => {
    it("renames the active scene and updates appState.name", async () => {
      const { editor, api } = createEditor();
      const id = getSceneIndex().activeSceneId;

      await renameScene(api, id, "  Plans  ");

      expect(getSceneIndex().scenes[0].name).toBe("Plans");
      expect(editor.appState.name).toBe("Plans");
    });

    it("renames an inactive scene without changing the canvas", async () => {
      const { editor, api } = createEditor();
      const firstId = getSceneIndex().activeSceneId;
      const created = await createScene(api, "Current");

      await renameScene(api, firstId, "Old");

      expect(
        getSceneIndex().scenes.find((scene) => scene.id === firstId)?.name,
      ).toBe("Old");
      expect(editor.appState.name).toBe(created.name);
    });

    it("rejects an empty name", async () => {
      const { api } = createEditor();
      const id = getSceneIndex().activeSceneId;
      const before = getSceneIndex().scenes[0].name;

      await expect(renameScene(api, id, "   ")).rejects.toThrow();
      expect(getSceneIndex().scenes[0].name).toBe(before);
    });
  });

  describe("delete", () => {
    it("can't delete the last scene", async () => {
      const { api } = createEditor([rect("a")]);
      await expect(
        deleteScene(api, getSceneIndex().activeSceneId),
      ).rejects.toThrow();
      expect(getSceneIndex().scenes).toHaveLength(1);
      expect(storedElementIds()).toEqual([]);
    });

    it("deletes an inactive scene and its stored data", async () => {
      const { editor, api } = createEditor([rect("a")]);
      const firstId = getSceneIndex().activeSceneId;
      const created = await createScene(api);

      await deleteScene(api, firstId);

      expect(getSceneIndex().scenes.map((s) => s.id)).toEqual([created.id]);
      expect(await get(firstId, scenesStore)).toBeUndefined();
      expect(editor.elements).toEqual([]);
    });

    it("deletes the active scene and moves to a neighbor", async () => {
      const { editor, api } = createEditor([rect("a")]);
      const firstId = getSceneIndex().activeSceneId;
      const created = await createScene(api);
      editor.elements = [rect("to-delete")];

      await deleteScene(api, created.id);

      const index = getSceneIndex();
      expect(index.activeSceneId).toBe(firstId);
      expect(index.scenes.map((s) => s.id)).toEqual([firstId]);
      expect(editor.elements.map((el) => el.id)).toEqual(["a"]);
      expect(storedElementIds()).toEqual(["a"]);
      expect(await get(created.id, scenesStore)).toBeUndefined();
    });
  });

  describe("image cleanup", () => {
    it("lists images from every stored scene", async () => {
      await saveStoredScene("scene-a", {
        elements: [imageElement("i1", "file-a")],
        appState: {},
      });
      await saveStoredScene("scene-b", {
        elements: [imageElement("i2", "file-b"), rect("r")],
        appState: {},
      });

      expect((await getAllSceneFileIds()).sort()).toEqual(["file-a", "file-b"]);
    });

    it("keeps images used only by an inactive scene", async () => {
      const old = Date.now() - 7 * 24 * 3600 * 1000;
      await set(
        "kept",
        { id: "kept", dataURL: "x", lastRetrieved: old },
        filesStore,
      );
      await set(
        "unused",
        { id: "unused", dataURL: "y", lastRetrieved: old },
        filesStore,
      );
      await saveStoredScene("inactive", {
        elements: [imageElement("img", "kept")],
        appState: {},
      });

      await LocalData.fileStorage.clearObsoleteFiles({
        currentFileIds: await getAllSceneFileIds(),
      });

      await vi.waitFor(async () => {
        expect(await get("unused", filesStore)).toBeUndefined();
      });
      expect(await get("kept", filesStore)).toBeTruthy();
    });
  });
});
