import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import DialogActionButton from "@excalidraw/excalidraw/components/DialogActionButton";
import DropdownMenu from "@excalidraw/excalidraw/components/dropdownMenu/DropdownMenu";
import {
  chevronDownIcon,
  pencilIcon,
  PlusIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useEffect, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAtomValue } from "../app-jotai";

import {
  createScene,
  deleteScene,
  refreshSceneIndex,
  renameScene,
  sceneIndexAtom,
  switchScene,
} from "./sceneManager";

import "./SceneSwitcher.scss";

import type { SceneMeta } from "./sceneStore";

const RenameSceneDialog = ({
  scene,
  onSave,
  onClose,
}: {
  scene: SceneMeta;
  onSave: (name: string) => void;
  onClose: () => void;
}) => {
  const [name, setName] = useState(scene.name);

  return (
    // Dialog would otherwise move focus from the input to the Cancel button
    <Dialog
      size="small"
      title="Rename scene"
      autofocus={false}
      onCloseRequest={onClose}
    >
      <input
        className="SceneSwitcher__renameInput"
        data-testid="scene-switcher-rename-input"
        aria-label="Scene name"
        autoFocus
        value={name}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSave(name);
          }
        }}
      />
      <div className="SceneSwitcher__renameActions">
        <DialogActionButton label="Cancel" onClick={onClose} />
        <DialogActionButton
          label="Save"
          actionType="primary"
          onClick={() => onSave(name)}
        />
      </div>
    </Dialog>
  );
};

export const SceneSwitcher = ({
  excalidrawAPI,
  isCollaborating,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  isCollaborating: boolean;
}) => {
  const index = useAtomValue(sceneIndexAtom);
  const [isOpen, setIsOpen] = useState(false);
  const [sceneToRename, setSceneToRename] = useState<SceneMeta | null>(null);
  const [sceneToDelete, setSceneToDelete] = useState<SceneMeta | null>(null);

  useEffect(() => {
    refreshSceneIndex();
  }, []);

  // switching is disabled during collaboration: saving is paused then, and the
  // canvas holds the room's content rather than the active scene
  useEffect(() => {
    if (isCollaborating) {
      setIsOpen(false);
    }
  }, [isCollaborating]);

  if (!index) {
    return null;
  }

  const activeScene = index.scenes.find(
    (scene) => scene.id === index.activeSceneId,
  );

  const run = (operation: () => Promise<unknown>) => {
    setIsOpen(false);
    operation().catch((error: Error) => {
      console.error(error);
      excalidrawAPI.setToast({ message: error.message, closable: true });
    });
  };

  return (
    <div className="SceneSwitcher">
      <DropdownMenu open={isOpen}>
        <DropdownMenu.Trigger
          className="SceneSwitcher__trigger"
          data-testid="scene-switcher-trigger"
          disabled={isCollaborating}
          title={
            isCollaborating
              ? "Scenes can't be switched during collaboration"
              : "Scenes"
          }
          onToggle={() => setIsOpen((open) => !open)}
        >
          <span className="SceneSwitcher__triggerName">
            {activeScene?.name}
          </span>
          <span className="SceneSwitcher__triggerIcon">{chevronDownIcon}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="SceneSwitcher__menu"
          onClickOutside={() => setIsOpen(false)}
        >
          <div className="SceneSwitcher__list">
            {index.scenes.map((scene) => (
              <div className="SceneSwitcher__row" key={scene.id}>
                <DropdownMenu.Item
                  className="SceneSwitcher__sceneItem"
                  data-testid={`scene-switcher-item-${scene.id}`}
                  selected={scene.id === index.activeSceneId}
                  title={scene.name}
                  onSelect={() =>
                    run(() => switchScene(excalidrawAPI, scene.id))
                  }
                >
                  {scene.name}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="SceneSwitcher__action"
                  data-testid={`scene-switcher-rename-${scene.id}`}
                  aria-label={`Rename ${scene.name}`}
                  onSelect={() => {
                    setIsOpen(false);
                    setSceneToRename(scene);
                  }}
                >
                  {pencilIcon}
                </DropdownMenu.Item>
                {index.scenes.length > 1 && (
                  <DropdownMenu.Item
                    className="SceneSwitcher__action"
                    data-testid={`scene-switcher-delete-${scene.id}`}
                    aria-label={`Delete ${scene.name}`}
                    onSelect={() => {
                      setIsOpen(false);
                      setSceneToDelete(scene);
                    }}
                  >
                    {TrashIcon}
                  </DropdownMenu.Item>
                )}
              </div>
            ))}
          </div>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            data-testid="scene-switcher-new"
            icon={PlusIcon}
            onSelect={() => run(() => createScene(excalidrawAPI))}
          >
            New scene
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>

      {sceneToRename && (
        <RenameSceneDialog
          scene={sceneToRename}
          onClose={() => setSceneToRename(null)}
          onSave={(name) => {
            setSceneToRename(null);
            run(() => renameScene(excalidrawAPI, sceneToRename.id, name));
          }}
        />
      )}

      {sceneToDelete && (
        <ConfirmDialog
          title="Delete scene"
          confirmText="Delete"
          onCancel={() => setSceneToDelete(null)}
          onConfirm={() => {
            setSceneToDelete(null);
            run(() => deleteScene(excalidrawAPI, sceneToDelete.id));
          }}
        >
          <p>
            Delete "{sceneToDelete.name}"? This can't be undone. Export it first
            if you want to keep a copy.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};
