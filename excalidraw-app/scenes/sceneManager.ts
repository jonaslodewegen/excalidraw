import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import {
  getNonDeletedElements,
  isInitializedImageElement,
} from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";
import { STORAGE_KEYS } from "../app_constants";
import { updateStaleImageStatuses } from "../data/FileManager";
import { LocalData } from "../data/LocalData";
import { updateBrowserStateVersion } from "../data/tabSync";

import {
  commitActiveScene,
  createSceneMeta,
  deleteStoredScene,
  getSceneIndex,
  loadStoredScene,
  saveSceneIndex,
  saveStoredScene,
} from "./sceneStore";

import type { SceneIndex, SceneMeta, StoredScene } from "./sceneStore";

const MAX_SCENE_NAME_LENGTH = 100;

/**
 * The scene list as this tab last saw it. `activeSceneId` is therefore the scene
 * this tab's canvas holds, which can lag behind storage if another tab switched.
 */
export const sceneIndexAtom = atom<SceneIndex | null>(null);

let isTransitioning = false;

export const refreshSceneIndex = () => {
  const index = getSceneIndex();
  appJotaiStore.set(sceneIndexAtom, index);
  return index;
};

/** Picks up changes from other tabs. Called when this tab regains focus. */
export const syncSceneIndexFromStorage = (api: ExcalidrawImperativeAPI) => {
  const previousIndex = appJotaiStore.get(sceneIndexAtom);
  const index = refreshSceneIndex();
  if (previousIndex && previousIndex.activeSceneId !== index.activeSceneId) {
    // undo deltas from the previous scene would apply to the new one
    api.history.clear();
  }
};

const normalizeSceneName = (name: string) => {
  const normalized = name.trim().slice(0, MAX_SCENE_NAME_LENGTH);
  if (!normalized) {
    throw new Error("Scene name can't be empty");
  }
  return normalized;
};

const getNextDefaultSceneName = (scenes: readonly SceneMeta[]) => {
  const highestNumber = scenes.reduce((highest, scene) => {
    const match = scene.name.match(/^Scene (\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `Scene ${highestNumber + 1}`;
};

/**
 * Returns the fresh scene list, refusing to continue if another tab changed the
 * active scene since this tab last synced. Otherwise this tab's canvas would be
 * saved under the wrong scene.
 */
const getIndexForUpdate = () => {
  const index = getSceneIndex();
  const tabIndex = appJotaiStore.get(sceneIndexAtom);
  if (tabIndex && tabIndex.activeSceneId !== index.activeSceneId) {
    throw new Error("Scenes changed in another tab. Please try again.");
  }
  return index;
};

const loadSceneImages = async (
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
) => {
  const currentFiles = api.getFiles();
  const fileIds = elements.reduce((acc, element) => {
    if (isInitializedImageElement(element) && !currentFiles[element.fileId]) {
      acc.push(element.fileId);
    }
    return acc;
  }, [] as FileId[]);

  if (!fileIds.length) {
    return;
  }

  const { loadedFiles, erroredFiles } = await LocalData.fileStorage.getFiles(
    fileIds,
  );
  if (loadedFiles.length) {
    api.addFiles(loadedFiles);
  }
  updateStaleImageStatuses({
    excalidrawAPI: api,
    erroredFiles,
    elements: api.getSceneElementsIncludingDeleted(),
  });
};

/**
 * Replaces the canvas with another scene. Any failure before the localStorage
 * commit aborts, leaving this tab on the current scene with its data intact.
 */
const activateScene = async (
  api: ExcalidrawImperativeAPI,
  opts: {
    /** The scene currently on the canvas, or null to discard it */
    sceneToSave: string | null;
    target: SceneMeta;
    nextScenes: SceneMeta[];
    loadTarget: () => Promise<StoredScene>;
  },
) => {
  const { sceneToSave, target, nextScenes, loadTarget } = opts;

  LocalData.flushSave();
  LocalData.pauseSave("sceneSwitch");
  api.updateScene({ appState: { isLoading: true } });

  let elements: readonly ExcalidrawElement[];
  try {
    const currentAppState = api.getAppState();

    if (sceneToSave) {
      const currentElements = getNonDeletedElements(
        api.getSceneElementsIncludingDeleted(),
      );
      const { erroredFiles } = await LocalData.fileStorage.saveFiles({
        elements: currentElements,
        files: api.getFiles(),
      });
      if (erroredFiles.size) {
        throw new Error("Couldn't save this scene's images");
      }
      await saveStoredScene(sceneToSave, {
        elements: currentElements,
        appState: clearAppStateForLocalStorage(currentAppState),
      });
    }

    const targetScene = await loadTarget();

    elements = restoreElements(targetScene.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    });
    const appState = {
      ...restoreAppState(targetScene.appState, null),
      // the theme and open sidebar belong to the user, not the scene
      theme: currentAppState.theme,
      openSidebar: currentAppState.openSidebar,
      name: target.name,
      isLoading: false,
    };

    commitActiveScene(
      { elements, appState },
      { activeSceneId: target.id, scenes: nextScenes },
    );

    api.updateScene({
      elements,
      appState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // undo deltas from the previous scene would apply to the new one
    api.history.clear();
    refreshSceneIndex();

    // make other tabs reload both the scene and its images on focus
    updateBrowserStateVersion(STORAGE_KEYS.VERSION_DATA_STATE);
    updateBrowserStateVersion(STORAGE_KEYS.VERSION_FILES);
  } catch (error: any) {
    api.updateScene({ appState: { isLoading: false } });
    throw error;
  } finally {
    LocalData.resumeSave("sceneSwitch");
  }

  // the switch has already happened, so a failure here mustn't undo it, and
  // images that can't be loaded are marked as errored on the canvas
  try {
    await loadSceneImages(api, elements);
  } catch (error: any) {
    console.error(error);
  }
};

/** Prevents overlapping operations, e.g. from double-clicking in the menu. */
const withTransitionLock = async <T>(operation: () => Promise<T>) => {
  if (isTransitioning) {
    throw new Error("Another scene operation is in progress");
  }
  isTransitioning = true;
  try {
    return await operation();
  } finally {
    isTransitioning = false;
  }
};

export const switchScene = (api: ExcalidrawImperativeAPI, sceneId: string) =>
  withTransitionLock(async () => {
    const index = getIndexForUpdate();
    if (index.activeSceneId === sceneId) {
      return;
    }

    const target = index.scenes.find((scene) => scene.id === sceneId);
    if (!target) {
      throw new Error("Scene not found");
    }

    await activateScene(api, {
      sceneToSave: index.activeSceneId,
      target,
      nextScenes: index.scenes,
      loadTarget: async () => {
        const scene = await loadStoredScene(sceneId);
        if (!scene) {
          throw new Error(`Couldn't load "${target.name}"`);
        }
        return scene;
      },
    });
  });

export const createScene = (api: ExcalidrawImperativeAPI, name?: string) =>
  withTransitionLock(async () => {
    const index = getIndexForUpdate();
    const target = createSceneMeta(
      name === undefined
        ? getNextDefaultSceneName(index.scenes)
        : normalizeSceneName(name),
    );

    await activateScene(api, {
      sceneToSave: index.activeSceneId,
      target,
      nextScenes: [...index.scenes, target],
      loadTarget: async () => ({ elements: [], appState: {} }),
    });

    return target;
  });

export const renameScene = async (
  api: ExcalidrawImperativeAPI,
  sceneId: string,
  name: string,
) => {
  const normalizedName = normalizeSceneName(name);
  const index = getIndexForUpdate();

  saveSceneIndex({
    ...index,
    scenes: index.scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, name: normalizedName } : scene,
    ),
  });
  refreshSceneIndex();

  if (index.activeSceneId === sceneId) {
    api.updateScene({
      appState: { name: normalizedName },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
};

export const deleteScene = (api: ExcalidrawImperativeAPI, sceneId: string) =>
  withTransitionLock(async () => {
    const index = getIndexForUpdate();
    if (index.scenes.length <= 1) {
      throw new Error("The last scene can't be deleted");
    }

    const position = index.scenes.findIndex((scene) => scene.id === sceneId);
    if (position === -1) {
      throw new Error("Scene not found");
    }
    const nextScenes = index.scenes.filter((scene) => scene.id !== sceneId);

    if (index.activeSceneId === sceneId) {
      const target = nextScenes[Math.min(position, nextScenes.length - 1)];
      await activateScene(api, {
        sceneToSave: null,
        target,
        nextScenes,
        loadTarget: async () => {
          const scene = await loadStoredScene(target.id);
          if (!scene) {
            throw new Error(`Couldn't load "${target.name}"`);
          }
          return scene;
        },
      });
    } else {
      saveSceneIndex({ ...index, scenes: nextScenes });
      refreshSceneIndex();
    }

    // Done last: if this fails, it leaves unused data rather than a scene in the
    // list with nothing behind it. Its images are removed later by file cleanup.
    await deleteStoredScene(sceneId);
  });
