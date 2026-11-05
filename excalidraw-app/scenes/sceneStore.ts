/**
 * Storage for multi-scene support.
 *
 * - The active scene stays in the existing localStorage keys, so `LocalData`,
 *   tab sync and collaboration work on it unchanged.
 * - Inactive scenes live in IndexedDB, as localStorage is too small for them.
 * - The scene list lives in localStorage, so it can be read synchronously. It's
 *   re-read before every operation, as other tabs may have changed it.
 */

import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import { randomId } from "@excalidraw/common";
import { isInitializedImageElement } from "@excalidraw/element";
import { createStore, del, entries, get, set } from "idb-keyval";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

export type SceneMeta = {
  id: string;
  name: string;
  createdAt: number;
};

export type SceneIndex = {
  activeSceneId: string;
  scenes: SceneMeta[];
};

export type StoredScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
};

const scenesStore = createStore("excalidraw-scenes-db", "scenes-store");

export const createSceneMeta = (name: string): SceneMeta => ({
  id: randomId(),
  name,
  createdAt: Date.now(),
});

const isValidSceneIndex = (index: any): index is SceneIndex =>
  Array.isArray(index?.scenes) &&
  index.scenes.some((scene: SceneMeta) => scene?.id === index.activeSceneId);

const readStoredIndex = (): SceneIndex | null => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_SCENES);
    const index = stored ? JSON.parse(stored) : null;
    return isValidSceneIndex(index) ? index : null;
  } catch (error: any) {
    console.error(error);
    return null;
  }
};

export const saveSceneIndex = (index: SceneIndex) => {
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_SCENES,
    JSON.stringify(index),
  );
};

/**
 * Returns the scene list. On first run this adopts whatever drawing is already
 * in localStorage as "Scene 1", without touching its data.
 */
export const getSceneIndex = (): SceneIndex => {
  const stored = readStoredIndex();
  if (stored) {
    return stored;
  }

  const firstScene = createSceneMeta("Scene 1");
  const index = { activeSceneId: firstScene.id, scenes: [firstScene] };
  try {
    saveSceneIndex(index);
  } catch (error: any) {
    console.error(error);
  }
  return index;
};

export const saveStoredScene = (id: string, scene: StoredScene) =>
  set(id, scene, scenesStore);

export const loadStoredScene = (id: string) =>
  get<StoredScene>(id, scenesStore);

export const deleteStoredScene = (id: string) => del(id, scenesStore);

/** Images used by stored scenes, which file cleanup must not delete. */
export const getAllSceneFileIds = async (): Promise<FileId[]> => {
  const fileIds = new Set<FileId>();
  const scenes = await entries<string, StoredScene>(scenesStore);
  for (const [, scene] of scenes) {
    for (const element of scene.elements) {
      if (isInitializedImageElement(element)) {
        fileIds.add(element.fileId);
      }
    }
  }
  return [...fileIds];
};

/**
 * Makes a scene the active one in localStorage. Either everything is written or
 * nothing is: if the data and the active scene ID disagreed, a reload would show
 * one scene's content under another's name.
 */
export const commitActiveScene = (scene: StoredScene, index: SceneIndex) => {
  const writes: [key: string, value: string][] = [
    [STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, JSON.stringify(scene.elements)],
    [
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(clearAppStateForLocalStorage(scene.appState)),
    ],
    [STORAGE_KEYS.LOCAL_STORAGE_SCENES, JSON.stringify(index)],
  ];

  const previousValues: [key: string, value: string | null][] = [];
  try {
    for (const [key, value] of writes) {
      const previousValue = localStorage.getItem(key);
      localStorage.setItem(key, value);
      previousValues.push([key, previousValue]);
    }
  } catch (error: any) {
    for (const [key, value] of previousValues.reverse()) {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    }
    throw error;
  }
};
