import { DNodeUtils, NoteChangeEntry, VaultUtils } from "@dendronhq/common-all";
import { vault2Path } from "@dendronhq/common-server";
import { HistoryEvent } from "@dendronhq/engine-server";
import _ from "lodash";
import path from "path";
import { TextEditor, Uri, window } from "vscode";
import {
  OldNewLocation,
  PickerUtilsV2,
  ProviderAcceptHooks,
} from "../components/lookup/utils";
import { NoteLookupProviderUtils } from "../components/lookup/NoteLookupProviderUtils";
import { DENDRON_COMMANDS } from "../constants";
import { ExtensionProvider } from "../ExtensionProvider";
import { FileItem } from "../external/fileutils/FileItem";
import { VSCodeUtils } from "../vsCodeUtils";
import { getDWorkspace, getExtension } from "../workspace";
import { BaseCommand } from "./base";

type CommandInput = {
  move: OldNewLocation[];
};

type CommandOpts = {
  files: { oldUri: Uri; newUri: Uri }[];
  silent: boolean;
  closeCurrentFile: boolean;
  openNewFile: boolean;
  noModifyWatcher?: boolean;
};
type CommandOutput = {
  changed: NoteChangeEntry[];
};

export { CommandOutput as RenameNoteOutputV2a };

export class RenameNoteV2aCommand extends BaseCommand<
  CommandOpts,
  CommandOutput,
  CommandInput
> {
  key = DENDRON_COMMANDS.RENAME_NOTE.key;
  public silent?: boolean;

  async gatherInputs(): Promise<CommandInput> {
    const extension = ExtensionProvider.getExtension();
    const lc = extension.lookupControllerFactory.create({
      nodeType: "note",
    });
    const provider = extension.noteLookupProviderFactory.create("rename", {
      allowNewNote: true,
    });
    provider.registerOnAcceptHook(ProviderAcceptHooks.oldNewLocationHook);

    const initialValue = path.basename(
      VSCodeUtils.getActiveTextEditor()?.document.uri.fsPath || "",
      ".md"
    );
    return new Promise((resolve) => {
      NoteLookupProviderUtils.subscribe({
        id: "rename",
        controller: lc,
        logger: this.L,
        onDone: (event: HistoryEvent) => {
          resolve({ move: event.data.onAcceptHookResp });
        },
      });
      lc.show({
        title: "Rename note",
        placeholder: "foo",
        provider,
        initialValue,
      });
    });
  }

  async enrichInputs(inputs: CommandInput): Promise<CommandOpts> {
    const editor = VSCodeUtils.getActiveTextEditor() as TextEditor;
    const oldUri: Uri = editor.document.uri;
    const vault = PickerUtilsV2.getOrPromptVaultForOpenEditor();
    const move = inputs.move[0];
    const fname = move.newLoc.fname;
    const vpath = vault2Path({ vault, wsRoot: getDWorkspace().wsRoot });
    const newUri = Uri.file(path.join(vpath, fname + ".md"));
    return {
      files: [{ oldUri, newUri }],
      silent: false,
      closeCurrentFile: true,
      openNewFile: true,
    };
  }

  async sanityCheck() {
    if (_.isUndefined(VSCodeUtils.getActiveTextEditor())) {
      return "No document open";
    }
    return;
  }

  async showResponse(res: CommandOutput) {
    const { changed } = res;
    if (changed.length > 0 && !this.silent) {
      window.showInformationMessage(`Dendron updated ${changed.length} files`);
    }
  }

  async execute(opts: CommandOpts) {
    const ctx = "RenameNoteV2a";
    this.L.info({ ctx, msg: "enter", opts });
    const ext = getExtension();
    try {
      const { files } = opts;
      const { newUri, oldUri } = files[0];
      if (ext.fileWatcher && !opts.noModifyWatcher) {
        ext.fileWatcher.pause = true;
      }
      const engine = ext.getEngine();
      const oldFname = DNodeUtils.fname(oldUri.fsPath);
      const vault = VaultUtils.getVaultByFilePath({
        fsPath: oldUri.fsPath,
        wsRoot: getDWorkspace().wsRoot,
        vaults: engine.vaults,
      });

      const resp = await engine.renameNote({
        oldLoc: {
          fname: oldFname,
          vaultName: VaultUtils.getName(vault),
        },
        newLoc: {
          fname: DNodeUtils.fname(newUri.fsPath),
          vaultName: VaultUtils.getName(vault),
        },
      });
      const changed = resp.data as NoteChangeEntry[];

      // re-link
      if (!this.silent) {
        if (opts.closeCurrentFile) {
          await VSCodeUtils.closeCurrentFileEditor();
        }
        if (opts.openNewFile) {
          await VSCodeUtils.openFileInEditor(new FileItem(files[0].newUri));
        }
      }
      return {
        changed,
      };
    } finally {
      if (ext.fileWatcher && !opts.noModifyWatcher) {
        setTimeout(() => {
          if (ext.fileWatcher) {
            ext.fileWatcher.pause = false;
          }
          this.L.info({ ctx, state: "exit:pause_filewatcher" });
        }, 3000);
      } else {
        this.L.info({ ctx, state: "exit" });
      }
    }
  }
}
