import {
  asyncLoopOneAtATime,
  ConfigUtils,
  CONSTANTS,
  CURRENT_CONFIG_VERSION,
  DendronError,
  DENDRON_VSCODE_CONFIG_KEYS,
  DEngineClient,
  Disposable,
  DuplicateNoteActionEnum,
  DUser,
  DUtils,
  DVault,
  DVaultSync,
  DWorkspace,
  DWorkspaceEntry,
  FOLDERS,
  InstallStatus,
  IntermediateDendronConfig,
  NoteUtils,
  SchemaUtils,
  SeedEntry,
  SelfContainedVault,
  Time,
  VaultUtils,
  WorkspaceSettings,
} from "@dendronhq/common-all";
import {
  assignJSONWithComment,
  createDisposableLogger,
  DLogger,
  GitUtils,
  note2File,
  readJSONWithComments,
  schemaModuleOpts2File,
  simpleGit,
  vault2Path,
  writeJSONWithComments,
  writeJSONWithCommentsSync,
} from "@dendronhq/common-server";
import fs from "fs-extra";
import _ from "lodash";
import os from "os";
import path, { basename } from "path";
import { WorkspaceUtils } from ".";
import { DConfig } from "../config";
import { MetadataService } from "../metadata";
import {
  CONFIG_MIGRATIONS,
  MigrationChangeSetStatus,
  MigrationService,
} from "../migrations";
import { SeedService, SeedUtils } from "../seed";
import { Git } from "../topics/git";
import {
  EngineUtils,
  getWSMetaFilePath,
  removeCache,
  writeWSMetaFile,
} from "../utils";
import { WorkspaceConfig } from "./vscode";
import {
  IWorkspaceService,
  SyncActionResult,
  SyncActionStatus,
} from "./workspaceServiceInterface";

const DENDRON_WS_NAME = CONSTANTS.DENDRON_WS_NAME;

export type PathExistBehavior = "delete" | "abort" | "continue";

export type WorkspaceServiceCreateOpts = {
  wsRoot: string;
  vaults?: DVault[];
  /**
   * create dendron.code-workspace file
   */
  createCodeWorkspace?: boolean;
  /** Create a self contained vault as the workspace */
  useSelfContainedVault?: boolean;
};

export type WorkspaceServiceOpts = {
  wsRoot: string;
  seedService?: SeedService;
};

type UrlTransformerFunc = (url: string) => string;

type AddRemoveCommonOpts = {
  /**
   * Default: true
   */
  updateConfig?: boolean;
  /**
   * Default: false
   */
  updateWorkspace?: boolean;

  /**
   * Method to run immediately before updating the workspace file - this is
   * useful as updating the workspace file while it's open will sometimes cause
   * the window to reload and the plugin to restart
   */
  onUpdatingWorkspace?: () => Promise<void>;

  /**
   * Method to run immediately after updating the workspace file
   */
  onUpdatedWorkspace?: () => Promise<void>;
};

const ROOT_NOTE_TEMPLATE = [
  "# Welcome to Dendron",
  "",
  `This is the root of your dendron vault. If you decide to publish your entire vault, this will be your landing page. You are free to customize any part of this page except the frontmatter on top.`,
  "",
  "## Lookup",
  "",
  "This section contains useful links to related resources.",
  "",
  "- [Getting Started Guide](https://link.dendron.so/6b25)",
  "- [Discord](https://link.dendron.so/6b23)",
  "- [Home Page](https://wiki.dendron.so/)",
  "- [Github](https://link.dendron.so/6b24)",
  "- [Developer Docs](https://docs.dendron.so/)",
].join("\n");

/** You **must** dispose workspace services you create, otherwise you risk leaking file descriptors which may lead to crashes. */
export class WorkspaceService implements Disposable, IWorkspaceService {
  public logger: DLogger;
  private loggerDispose: () => any;
  protected _seedService: SeedService;

  static isNewVersionGreater({
    oldVersion,
    newVersion,
  }: {
    oldVersion: string;
    newVersion: string;
  }) {
    return DUtils.semver.lt(oldVersion, newVersion);
  }

  static async isWorkspaceVault(fpath: string) {
    return fs.pathExists(path.join(fpath, CONSTANTS.DENDRON_CONFIG_FILE));
  }

  public wsRoot: string;

  /** Reminder: you **must** dispose workspace services you create, otherwise you risk leaking file descriptors which may lead to crashes. */
  constructor({ wsRoot, seedService }: WorkspaceServiceOpts) {
    this.wsRoot = wsRoot;
    const { logger, dispose } = createDisposableLogger();
    this.logger = logger;
    this.loggerDispose = dispose;
    this._seedService = seedService || new SeedService({ wsRoot });
  }

  dispose() {
    this.loggerDispose();
  }

  get user(): DUser {
    const fpath = path.join(this.wsRoot, CONSTANTS.DENDRON_USER_FILE);
    if (fs.existsSync(fpath)) {
      return new DUser(_.trim(fs.readFileSync(fpath, { encoding: "utf8" })));
    } else {
      return DUser.createAnonymous();
    }
  }

  static getOrCreateConfig(wsRoot: string) {
    return DConfig.getOrCreate(wsRoot);
  }

  get config(): IntermediateDendronConfig {
    // `createConfig` function relies on this creating a config. If revising the code, make sure to update that function as well.
    return WorkspaceService.getOrCreateConfig(this.wsRoot);
  }

  get seedService(): SeedService {
    return this._seedService;
  }

  async setConfig(config: IntermediateDendronConfig) {
    const wsRoot = this.wsRoot;
    return DConfig.writeConfig({ wsRoot, config });
  }

  setCodeWorkspaceSettingsSync(config: WorkspaceSettings) {
    writeJSONWithCommentsSync(
      path.join(this.wsRoot, CONSTANTS.DENDRON_WS_NAME),
      config
    );
  }

  getCodeWorkspaceSettingsSync(): WorkspaceSettings | undefined {
    const resp = WorkspaceUtils.getCodeWorkspaceSettingsSync(this.wsRoot);
    if (resp.error) {
      this.logger.error(resp.error);
      return undefined;
    }
    return resp.data;
  }

  /**
   *
   * @param param0
   * @returns `{vaults}` that have been added
   */
  async addWorkspace({ workspace }: { workspace: DWorkspace }) {
    const config = this.config;
    const allWorkspaces = ConfigUtils.getWorkspace(config).workspaces || {};
    allWorkspaces[workspace.name] = _.omit(workspace, ["name", "vaults"]);
    // update vault
    const newVaults = await _.reduce(
      workspace.vaults,
      async (acc, vault) => {
        const out = await acc;
        out.push(
          await this.addVault({
            config,
            vault: { ...vault, workspace: workspace.name },
            updateConfig: false,
          })
        );
        return out;
      },
      Promise.resolve([] as DVault[])
    );
    ConfigUtils.setWorkspaceProp(config, "workspaces", allWorkspaces);
    await this.setConfig(config);
    return { vaults: newVaults };
  }

  /**
   *
   *
   * @param opts.vault - {@link DVault} to add to workspace
   * @param opts.config - if passed it, make modifications on passed in config instead of {wsRoot}/dendron.yml
   * @param opts.writeConfig - default: true, add to dendron.yml
   * @param opts.addToWorkspace - default: false, add to dendron.code-workspace. Make sure to keep false for Native workspaces.
   * @returns
   */
  async addVault(
    opts: {
      vault: DVault;
      config?: IntermediateDendronConfig;
    } & AddRemoveCommonOpts
  ) {
    const { vault, config, updateConfig, updateWorkspace } = _.defaults(opts, {
      config: this.config,
      updateConfig: true,
      updateWorkspace: false,
    });

    const vaults = ConfigUtils.getVaults(config);
    vaults.unshift(vault);
    ConfigUtils.setVaults(config, vaults);

    // update dup note behavior
    const publishingConfig = ConfigUtils.getPublishingConfig(config);
    if (!publishingConfig.duplicateNoteBehavior) {
      const vaults = ConfigUtils.getVaults(config);
      const updatedDuplicateNoteBehavior = {
        action: DuplicateNoteActionEnum.useVault,
        payload: vaults.map((v) => VaultUtils.getName(v)),
      };
      ConfigUtils.setDuplicateNoteBehavior(
        config,
        updatedDuplicateNoteBehavior
      );
    } else if (_.isArray(publishingConfig.duplicateNoteBehavior.payload)) {
      const updatedDuplicateNoteBehavior =
        publishingConfig.duplicateNoteBehavior;
      (updatedDuplicateNoteBehavior.payload as string[]).push(
        VaultUtils.getName(vault)
      );
      ConfigUtils.setDuplicateNoteBehavior(
        config,
        updatedDuplicateNoteBehavior
      );
    }
    if (updateConfig) {
      await this.setConfig(config);
    }
    if (updateWorkspace) {
      const wsPath = path.join(this.wsRoot, DENDRON_WS_NAME);
      let out = (await readJSONWithComments(
        wsPath
      )) as unknown as WorkspaceSettings;
      if (
        !_.find(out.folders, (ent) => ent.path === VaultUtils.getRelPath(vault))
      ) {
        const vault2Folder = VaultUtils.toWorkspaceFolder(vault);
        const folders = [vault2Folder].concat(out.folders);
        out = assignJSONWithComment({ folders }, out);

        if (opts.onUpdatingWorkspace) {
          await opts.onUpdatingWorkspace();
        }
        await writeJSONWithComments(wsPath, out);

        if (opts.onUpdatedWorkspace) {
          await opts.onUpdatedWorkspace();
        }
      }
    } else {
      // Run the hooks even if not updating the workspace file (native workspace), because other code depends on it.
      if (opts.onUpdatingWorkspace) {
        await opts.onUpdatingWorkspace();
      }
      if (opts.onUpdatedWorkspace) {
        await opts.onUpdatedWorkspace();
      }
    }
    return vault;
  }

  /**
   * Create vault files if it does not exist
   * @param opts.noAddToConfig: don't add to dendron.yml
   * @param opts.addToCodeWorkspace: add to dendron.code-workspace
   * @returns void
   *
   * Effects:
   *   - updates `dendron.yml` if `noAddToConfig` is not set
   *   - create directory
   *   - create root note and root schema
   */
  async createVault(
    opts: {
      noAddToConfig?: boolean;
      addToCodeWorkspace?: boolean;
    } & Parameters<WorkspaceService["addVault"]>[0]
  ) {
    const { vault, noAddToConfig } = opts;
    const vpath = vault2Path({ vault, wsRoot: this.wsRoot });
    await fs.ensureDir(vpath);

    const note = NoteUtils.createRoot({
      vault,
      body: ROOT_NOTE_TEMPLATE,
    });
    const schema = SchemaUtils.createRootModule({ vault });

    if (!fs.existsSync(NoteUtils.getFullPath({ note, wsRoot: this.wsRoot }))) {
      await note2File({ note, vault, wsRoot: this.wsRoot });
    }
    if (!fs.existsSync(SchemaUtils.getPath({ root: vpath, fname: "root" }))) {
      await schemaModuleOpts2File(schema, vpath, "root");
    }

    if (!noAddToConfig) {
      await this.addVault({ ...opts, updateWorkspace: false });
    }
    if (opts.addToCodeWorkspace || opts.updateWorkspace) {
      await this.addVaultToCodeWorkspace(vault);
    }
    return vault;
  }

  /** Creates the given vault.
   *
   * @param vault Must be a self contained vault. Use
   * {@link VaultUtils.selfContained} to ensure this is correct, which will
   * allow the type to match.
   * @param addToConfig If true, the created vault will be added to the config
   * for the current workspace.
   * @param addToCodeWorkspace If true, the created vault will be added to the
   * `code-workspace` file for the current workspace.
   */
  async createSelfContainedVault(opts: {
    addToConfig?: boolean;
    addToCodeWorkspace?: boolean;
    // Must be created with a self-contained vault
    vault: SelfContainedVault;
  }) {
    const { vault, addToConfig, addToCodeWorkspace } = opts;
    /** The `vault` folder */
    const vaultPath = path.join(this.wsRoot, vault.fsPath);
    /** The `vault/notes` folder */
    const notesPath = path.join(vaultPath, FOLDERS.NOTES);
    // Create the folders we want for this vault.
    await fs.mkdirp(notesPath);
    await fs.mkdirp(path.join(notesPath, "assets"));

    // Create root note and schema
    const note = NoteUtils.createRoot({
      vault,
      body: ROOT_NOTE_TEMPLATE,
    });
    const schema = SchemaUtils.createRootModule({ vault });
    if (
      !(await fs.pathExists(
        NoteUtils.getFullPath({ note, wsRoot: this.wsRoot })
      ))
    ) {
      await note2File({ note, vault, wsRoot: this.wsRoot });
    }
    if (
      !(await fs.pathExists(
        SchemaUtils.getPath({ root: notesPath, fname: "root" })
      ))
    ) {
      await schemaModuleOpts2File(schema, notesPath, "root");
    }

    // Create the config and code-workspace for the vault, which make it self contained.
    // This is the config that goes inside the vault itself
    const selfContainedVaultConfig: DVault = {
      fsPath: ".",
      selfContained: true,
    };
    if (vault.name) selfContainedVaultConfig.name = vault.name;
    DConfig.getOrCreate(vaultPath, {
      dev: {
        enableSelfContainedVaults: true,
      },
      workspace: {
        vaults: [selfContainedVaultConfig],
      },
    });
    WorkspaceConfig.write(vaultPath, [], {
      overrides: {
        folders: [
          {
            // Following how we set up workspace config for workspaces, where
            // the root is the `vault` directory
            path: "notes",
            name: VaultUtils.getName(vault),
          },
        ],
        settings: {
          // Also enable the self contained vault workspaces when inside the self contained vault
          [DENDRON_VSCODE_CONFIG_KEYS.ENABLE_SELF_CONTAINED_VAULTS_WORKSPACE]:
            true,
        },
      },
    });
    // Also add a gitignore, so files like `.dendron.port` are ignored if the
    // self contained vault is opened on its own
    await WorkspaceService.createGitIgnore(vaultPath);

    // Update the config and code-workspace for the current workspace
    if (addToConfig) {
      await this.addVault({ ...opts, updateWorkspace: false });
    }
    if (addToCodeWorkspace) {
      await this.addVaultToCodeWorkspace(vault);
    }
    return vault;
  }

  markVaultAsRemoteInConfig(
    targetVault: DVault,
    remoteUrl: string
  ): Promise<void> {
    const config = this.config;
    const vaults = ConfigUtils.getVaults(config);
    ConfigUtils.setVaults(
      config,
      vaults.map((vault) => {
        if (VaultUtils.isEqualV2(vault, targetVault)) {
          vault.remote = { type: "git", url: remoteUrl };
        }
        return vault;
      })
    );
    return this.setConfig(config);
  }

  /** Converts a local vault to a remote vault, with `remoteUrl` as the upstream URL. */
  async convertVaultRemote({
    wsRoot,
    vault: targetVault,
    remoteUrl,
  }: {
    wsRoot: string;
    vault: DVault;
    remoteUrl: string;
  }) {
    // Add the vault to the gitignore of root, so that it doesn't show up as part of root anymore
    await GitUtils.addToGitignore({
      addPath: targetVault.fsPath,
      root: wsRoot,
    });

    // Now, initialize a repository in it
    const git = new Git({
      localUrl: path.join(wsRoot, targetVault.fsPath),
      remoteUrl,
    });
    if (!(await fs.pathExists(path.join(wsRoot, targetVault.fsPath, ".git")))) {
      // Avoid initializing if a git folder already exists
      await git.init();
    }
    let remote = await git.getRemote();
    if (!remote) {
      remote = await git.remoteAdd();
    } else {
      await git.remoteSet(remote);
    }
    const branch = await git.getCurrentBranch();
    // Add the contents of the vault and push to initialize the upstream
    await git.addAll();
    try {
      await git.commit({ msg: "Set up remote vault" });
    } catch (err: any) {
      // Ignore it if commit fails, it might happen if the vault if empty or if it was already a repo
      if (!_.isNumber(err?.exitCode)) throw err;
    }
    await git.push({ remote, branch });
    // Update `dendron.yml`, adding the remote to the converted vault
    await this.markVaultAsRemoteInConfig(targetVault, remoteUrl);
    // Remove the vault folder from the tree of the root repository. Otherwise, the files will be there when
    // someone else pulls the root repo, which can break remote vault initialization. This doesn't delete the actual files.
    if (await fs.pathExists(path.join(wsRoot, ".git"))) {
      // But only if the workspace is in a git repository, otherwise skip this step.
      const rootGit = new Git({ localUrl: wsRoot });
      await rootGit.rm({
        cached: true,
        recursive: true,
        path: targetVault.fsPath,
      });
    }

    return { remote, branch };
  }

  /** Converts a remote vault to a local vault. */
  async convertVaultLocal({
    wsRoot,
    vault: targetVault,
  }: {
    wsRoot: string;
    vault: DVault;
  }) {
    // Remove vault from gitignore of root, if it's there, so it's part of root workspace again
    await GitUtils.removeFromGitignore({
      removePath: targetVault.fsPath,
      root: wsRoot,
    });

    // Remove the .git folder from the vault
    const gitFolder = path.join(wsRoot, targetVault.fsPath, ".git");
    await fs.rm(gitFolder, {
      recursive: true,
      force: true /* It's OK if dir doesn't exist */,
    });
    // Update `dendron.yml`, removing the remote from the converted vault
    const config = this.config;
    const vaults = ConfigUtils.getVaults(config);
    ConfigUtils.setVaults(
      config,
      vaults.map((vault) => {
        if (VaultUtils.isEqualV2(vault, targetVault)) {
          delete vault.remote;
        }
        return vault;
      })
    );
    await this.setConfig(config);
  }

  /** For vaults in the same repository, ensure that their sync configurations do not conflict. Returns the coordinated sync config. */
  verifyVaultSyncConfigs(vaults: DVault[]): DVaultSync | undefined {
    let prevVault: DVault | undefined;
    for (const vault of vaults) {
      if (_.isUndefined(vault.sync)) continue;
      if (_.isUndefined(prevVault)) {
        prevVault = vault;
        continue;
      }
      if (prevVault.sync === vault.sync) continue;

      const prevVaultName = prevVault.name || prevVault.fsPath;
      const vaultName = vault.name || vault.fsPath;
      throw new DendronError({
        message: `Vaults ${prevVaultName} and ${vaultName} are in the same repository, but have conflicting configurations ${prevVault.sync} and ${vault.sync} set. Please remove conflicting configuration, or move vault to a different repository.`,
      });
    }
    return prevVault?.sync;
  }

  /** Checks if a given git command should be used on the vault based on user configuration.
   *
   * @param command The git command that we want to perform.
   * @param repo The location of the repository containing the vaults.
   * @param vaults The vaults on which the operation is being performed on.
   * @returns true if the command can be performed, false otherwise.
   */
  async shouldVaultsSync(
    command: "commit" | "push" | "pull",
    [root, vaults]: [string, DVault[]]
  ): Promise<boolean> {
    let workspaceVaultSyncConfig = this.verifyVaultSyncConfigs(vaults);
    if (_.isUndefined(workspaceVaultSyncConfig)) {
      if (await WorkspaceService.isWorkspaceVault(root)) {
        workspaceVaultSyncConfig = ConfigUtils.getWorkspace(this.config)
          .workspaceVaultSyncMode as DVaultSync;
        // default for workspace vaults
        if (_.isUndefined(workspaceVaultSyncConfig)) {
          workspaceVaultSyncConfig = DVaultSync.NO_COMMIT;
        }
      }
      // default for regular vaults
      else workspaceVaultSyncConfig = DVaultSync.SYNC;
    }

    if (workspaceVaultSyncConfig === DVaultSync.SKIP) return false;
    if (workspaceVaultSyncConfig === DVaultSync.SYNC) return true;
    if (
      workspaceVaultSyncConfig === DVaultSync.NO_COMMIT &&
      command === "commit"
    )
      return false;
    if (workspaceVaultSyncConfig === DVaultSync.NO_PUSH && command === "push")
      return false;
    return true;
  }

  private static async generateCommitMessage({
    vaults,
    engine,
  }: {
    vaults: DVault[];
    engine: DEngineClient;
  }): Promise<string> {
    const { version } = (await engine.info()).data || { version: "unknown" };

    return [
      "Dendron workspace sync",
      "",
      "## Synced vaults:",
      ...vaults.map((vault) => `- ${VaultUtils.getName(vault)}`),
      "",
      `Dendron version: ${version}`,
      `Hostname: ${os.hostname()}`,
    ].join("\n");
  }

  async commitAndAddAll({
    engine,
  }: {
    engine: DEngineClient;
  }): Promise<SyncActionResult[]> {
    const allReposVaults = await this.getAllReposVaults();
    const out = await Promise.all(
      _.map(
        [...allReposVaults.entries()],
        async (rootVaults: [string, DVault[]]): Promise<SyncActionResult> => {
          const [repo, vaults] = rootVaults;
          const git = new Git({ localUrl: repo });
          if (!(await this.shouldVaultsSync("commit", rootVaults)))
            return { repo, vaults, status: SyncActionStatus.SKIP_CONFIG };
          if (await git.hasMergeConflicts())
            return { repo, vaults, status: SyncActionStatus.MERGE_CONFLICT };
          if (await git.hasRebaseInProgress()) {
            // try to resume the rebase first, since we know there are no merge conflicts
            return {
              repo,
              vaults,
              status: SyncActionStatus.REBASE_IN_PROGRESS,
            };
          }
          if (!(await git.hasChanges()))
            return { repo, vaults, status: SyncActionStatus.NO_CHANGES };
          try {
            await git.addAll();
            await git.commit({
              msg: await WorkspaceService.generateCommitMessage({
                vaults,
                engine,
              }),
            });
            return { repo, vaults, status: SyncActionStatus.DONE };
          } catch (err: any) {
            const stderr = err.stderr ? `: ${err.stderr}` : "";
            throw new DendronError({
              message: `error adding and committing vault${stderr}`,
              payload: { err, repoPath: repo },
            });
          }
        }
      )
    );
    return out;
  }

  /**
   * Initialize all remote vaults
   * @param opts
   * @returns
   */
  async initialize(opts?: { onSyncVaultsProgress: any; onSyncVaultsEnd: any }) {
    const { onSyncVaultsProgress, onSyncVaultsEnd } = _.defaults(opts, {
      onSyncVaultsProgress: () => {},
      onSyncVaultsEnd: () => {},
    });
    const initializeRemoteVaults = ConfigUtils.getWorkspace(
      this.config
    ).enableRemoteVaultInit;
    if (initializeRemoteVaults) {
      const { didClone } = await this.syncVaults({
        config: this.config,
        progressIndicator: onSyncVaultsProgress,
      });
      if (didClone) {
        onSyncVaultsEnd();
      }
      return didClone;
    }
    return false;
  }

  /**
   * Remove vaults. Currently doesn't delete any files.
   * @param param0
   */
  async removeVault(opts: { vault: DVault } & AddRemoveCommonOpts) {
    const config = this.config;
    const { vault, updateConfig, updateWorkspace } = _.defaults(opts, {
      updateConfig: true,
      updateWorkspace: false,
    });

    const vaults = ConfigUtils.getVaults(config);
    const vaultsAfterReject = _.reject(vaults, (ent: DVault) => {
      const checks = [
        VaultUtils.getRelPath(ent) === VaultUtils.getRelPath(vault),
      ];
      if (vault.workspace) {
        checks.push(ent.workspace === vault.workspace);
      }
      return _.every(checks);
    });
    ConfigUtils.setVaults(config, vaultsAfterReject);

    const workspaces = ConfigUtils.getWorkspace(config).workspaces;
    if (vault.workspace && workspaces) {
      const vaultWorkspace = _.find(ConfigUtils.getVaults(config), {
        workspace: vault.workspace,
      });
      if (_.isUndefined(vaultWorkspace)) {
        delete workspaces[vault.workspace];
        ConfigUtils.setWorkspaceProp(config, "workspaces", workspaces);
      }
    }
    const publishingConfig = ConfigUtils.getPublishingConfig(config);
    if (
      publishingConfig.duplicateNoteBehavior &&
      _.isArray(publishingConfig.duplicateNoteBehavior.payload)
    ) {
      const vaults = ConfigUtils.getVaults(config);
      if (vaults.length === 1) {
        // if there is only one vault left, remove duplicateNoteBehavior setting
        ConfigUtils.unsetDuplicateNoteBehavior(config);
      } else {
        // otherwise pull the removed vault from payload
        const updatedDuplicateNoteBehavior =
          publishingConfig.duplicateNoteBehavior;

        _.pull(updatedDuplicateNoteBehavior.payload as string[], vault.fsPath);

        ConfigUtils.setDuplicateNoteBehavior(
          config,
          updatedDuplicateNoteBehavior
        );
      }
    }
    if (updateConfig) {
      await this.setConfig(config);
    }
    if (updateWorkspace) {
      const wsPath = path.join(this.wsRoot, DENDRON_WS_NAME);
      let settings = (await readJSONWithComments(
        wsPath
      )) as unknown as WorkspaceSettings;
      const folders = _.reject(
        settings.folders,
        (ent) => ent.path === VaultUtils.getRelPath(vault)
      );
      settings = assignJSONWithComment({ folders }, settings);

      if (opts.onUpdatingWorkspace) {
        opts.onUpdatingWorkspace();
      }

      writeJSONWithCommentsSync(wsPath, settings);

      if (opts.onUpdatedWorkspace) {
        await opts.onUpdatedWorkspace();
      }
    } else {
      // Run the hooks even if not updating the workspace file (native workspace), because other code depends on it.
      if (opts.onUpdatingWorkspace) {
        opts.onUpdatingWorkspace();
      }
      if (opts.onUpdatedWorkspace) {
        await opts.onUpdatedWorkspace();
      }
    }
  }

  createConfig() {
    // This line actually does something: it will create a config if one doesn't exist.
    // eslint-disable-next-line no-unused-expressions
    this.config;
  }

  static async createGitIgnore(wsRoot: string) {
    const gitIgnore = path.join(wsRoot, ".gitignore");
    await fs.writeFile(
      gitIgnore,
      [
        "node_modules",
        ".dendron.*",
        "build",
        "seeds",
        ".next",
        "pods/service-connections",
      ].join("\n"),
      { encoding: "utf8" }
    );
  }

  /**
   * Initialize workspace with specified vaults
   * Files and folders created:
   * wsRoot/
   * - .gitignore
   * - dendron.yml
   * - {vaults}/
   *   - root.md
   *   - root.schema.yml
   *
   * NOTE: dendron.yml only gets created if you are adding a workspace...
   * @param opts
   */
  static async createWorkspace(opts: WorkspaceServiceCreateOpts) {
    if (opts.useSelfContainedVault) {
      return this.createSelfContainedVaultWorkspace(opts);
    } else {
      return this.createStandardWorkspace(opts);
    }
  }

  static async createStandardWorkspace(opts: WorkspaceServiceCreateOpts) {
    const { wsRoot, vaults } = opts;
    const ws = new WorkspaceService({ wsRoot });
    fs.ensureDirSync(wsRoot);
    // this creates `dendron.yml`
    ws.createConfig();
    // add gitignore
    WorkspaceService.createGitIgnore(wsRoot);
    if (opts.createCodeWorkspace) {
      WorkspaceConfig.write(wsRoot, vaults);
    }
    await _.reduce(
      vaults,
      async (prev, vault) => {
        await prev;
        await ws.createVault({ vault });
        return;
      },
      Promise.resolve()
    );
    // check if this is the first workspace created
    if (_.isUndefined(MetadataService.instance().getMeta().firstWsInitialize)) {
      MetadataService.instance().setFirstWsInitialize();
    }
    return ws;
  }

  /** Given a standard vault, convert it into a self contained vault.
   *
   * The function **mutates** (modifies) the vault object. */
  static standardToSelfContainedVault(vault: DVault): SelfContainedVault {
    if (VaultUtils.isSelfContained(vault)) return vault;

    if (vault.remote?.url) {
      // Remote vault, calculate path based on the remote
      vault.fsPath = path.join(
        FOLDERS.DEPENDENCIES,
        GitUtils.remoteUrlToDependencyPath({
          vaultName: vault.name || basename(vault.fsPath),
          url: vault.remote.url,
        })
      );
    } else {
      // Local vault, calculate path for local deps
      vault.fsPath = path.join(
        FOLDERS.DEPENDENCIES,
        FOLDERS.LOCAL_DEPENDENCY,
        path.basename(vault.fsPath)
      );
    }

    vault.selfContained = true;
    // Cast required, because TypeScript doesn't recognize `selfContained` is always set to true
    return vault as SelfContainedVault;
  }

  /** Creates a new workspace where the workspace is a self contained vault.
   *
   * If the vaults passed to this function are not self contained vaults, they
   * will be converted to self contained vaults before being created. The vault
   * objects passed in are **mutated**.
   *
   * Further, the first vault given will be the self contained vault that is
   * used as the workspace root.
   */
  static async createSelfContainedVaultWorkspace(
    opts: WorkspaceServiceCreateOpts
  ) {
    const { wsRoot, vaults } = opts;
    const ws = new WorkspaceService({ wsRoot });
    if (vaults && vaults.length > 0) {
      // First vault is the self contained vault we are using as the workspace
      const wsVault = vaults[0];
      // The vault is the workspace too
      if (wsVault.name === undefined) {
        wsVault.name = path.basename(wsRoot);
      }
      wsVault.fsPath = ".";
      wsVault.selfContained = true;

      // Mutate vault objects to convert them to self contained vaults. The
      // first vault will be skipped because the conversion is a no-op for
      // vaults that are already self contained.
      const selfContainedVaults = vaults.map(
        WorkspaceService.standardToSelfContainedVault
      );
      // Needs to be done one at a time, otherwise config updates are racy
      await asyncLoopOneAtATime(selfContainedVaults, (vault) => {
        return ws.createSelfContainedVault({
          vault,
          addToCodeWorkspace: false,
          // Don't add to config, {@link SetupWorkspaceCommand} also adds vaults to the config
          addToConfig: false,
        });
      });
    }

    // check if this is the first workspace created
    if (_.isUndefined(MetadataService.instance().getMeta().firstWsInitialize)) {
      MetadataService.instance().setFirstWsInitialize();
    }
    return ws;
  }

  static async createFromConfig(opts: { wsRoot: string }) {
    const { wsRoot } = opts;
    const config = DConfig.getOrCreate(wsRoot);
    const ws = new WorkspaceService({ wsRoot });
    const vaults = ConfigUtils.getVaults(config);
    await Promise.all(
      vaults.map(async (vault) => {
        return ws.cloneVaultWithAccessToken({ vault });
      })
    );
    ws.dispose();
    return;
  }

  async addVaultToCodeWorkspace(vault: DVault) {
    const wsRoot = this.wsRoot;

    // workspace file
    const wsPath = WorkspaceConfig.workspaceFile(wsRoot);
    let out: WorkspaceSettings;
    try {
      out = (await readJSONWithComments(
        wsPath
      )) as unknown as WorkspaceSettings;
    } catch (err: any) {
      // If the config file didn't exist, ignore the error
      if (err?.code === "ENOENT") return;
      throw err;
    }
    if (
      !_.find(out.folders, (ent) => ent.path === VaultUtils.getRelPath(vault))
    ) {
      const vault2Folder = VaultUtils.toWorkspaceFolder(vault);
      const folders = [vault2Folder].concat(out.folders);
      out = assignJSONWithComment({ folders }, out);
      await writeJSONWithComments(wsPath, out);
    }
    return;
  }

  /**
   * Used in createFromConfig
   */
  async cloneVaultWithAccessToken(opts: { vault: DVault }) {
    const { vault } = opts;
    if (!vault.remote || vault.remote.type !== "git") {
      throw new DendronError({ message: "cloning non-git vault" });
    }
    let remotePath = vault.remote.url;
    const localPath = vault2Path({ vault, wsRoot: this.wsRoot });
    const git = simpleGit();
    this.logger.info({ msg: "cloning", remotePath, localPath });
    const accessToken = process.env["GITHUB_ACCESS_TOKEN"];
    if (accessToken) {
      this.logger.info({ msg: "using access token" });
      remotePath = GitUtils.getGithubAccessTokenUrl({
        remotePath,
        accessToken,
      });
    }
    await git.clone(remotePath, localPath);
  }

  /**
   * Clone a vault from a remote source
   * @param opts.vault vaults field
   * @param opts.urlTransformer modify the git url
   */
  async cloneVault(opts: {
    vault: DVault;
    urlTransformer?: UrlTransformerFunc;
  }) {
    const { vault, urlTransformer } = _.defaults(opts, {
      urlTransformer: _.identity,
    });
    const wsRoot = this.wsRoot;
    if (!vault.remote || vault.remote.type !== "git") {
      throw new DendronError({ message: "cloning non-git vault" });
    }
    const repoPath = vault2Path({ wsRoot, vault });
    this.logger.info({ msg: "cloning", repoPath });
    const git = simpleGit({ baseDir: wsRoot });
    await git.clone(urlTransformer(vault.remote.url), repoPath);
    return repoPath;
  }

  async cloneWorkspace(opts: {
    wsName: string;
    workspace: DWorkspaceEntry;
    wsRoot: string;
    urlTransformer?: UrlTransformerFunc;
  }) {
    const { wsRoot, urlTransformer, workspace, wsName } = _.defaults(opts, {
      urlTransformer: _.identity,
    });
    const repoPath = path.join(wsRoot, wsName);
    const git = simpleGit({ baseDir: wsRoot });
    await git.clone(urlTransformer(workspace.remote.url), wsName);
    return repoPath;
  }

  async getVaultRepo(vault: DVault) {
    const vpath = vault2Path({ vault, wsRoot: this.wsRoot });
    return GitUtils.getGitRoot(vpath);
  }

  async getAllReposVaults(): Promise<Map<string, DVault[]>> {
    const reposVaults = new Map<string, DVault[]>();
    const vaults = ConfigUtils.getVaults(this.config);
    await Promise.all(
      vaults.map(async (vault) => {
        const repo = await this.getVaultRepo(vault);
        if (_.isUndefined(repo)) return;
        const vaultsForRepo = reposVaults.get(repo) || [];
        vaultsForRepo.push(vault);
        reposVaults.set(repo, vaultsForRepo);
      })
    );
    return reposVaults;
  }

  async getAllRepos() {
    return [...(await this.getAllReposVaults()).keys()];
  }

  async pullVault(opts: { vault: DVault }) {
    const { vault } = _.defaults(opts, {
      urlTransformer: _.identity,
    });
    const wsRoot = this.wsRoot;
    if (!vault.remote || vault.remote.type !== "git") {
      throw new DendronError({ message: "pulling non-git vault" });
    }
    const repoPath = vault2Path({ wsRoot, vault });
    this.logger.info({ msg: "pulling ", repoPath });
    const git = simpleGit({ baseDir: repoPath });
    await git.pull();
    return repoPath;
  }

  /** Returns the list of vaults that were attempted to be pulled, even if there was nothing to pull. */
  async pullVaults(): Promise<SyncActionResult[]> {
    const ctx = "pullVaults";
    const allReposVaults = await this.getAllReposVaults();
    const out = await Promise.all(
      _.map(
        [...allReposVaults.entries()],
        async (rootVaults: [string, DVault[]]): Promise<SyncActionResult> => {
          const [repo, vaults] = rootVaults;
          const makeResult = (status: SyncActionStatus) => {
            return {
              repo,
              vaults,
              status,
            };
          };

          const git = new Git({ localUrl: repo });
          // It's impossible to pull if there is no remote or upstream
          if (!(await git.hasRemote()))
            return makeResult(SyncActionStatus.NO_REMOTE);
          // If there's a merge conflict, then we can't continue
          if (await git.hasMergeConflicts())
            return makeResult(SyncActionStatus.MERGE_CONFLICT);
          // A rebase in progress means there's no upstream, so it needs to come first.
          if (await git.hasRebaseInProgress()) {
            return makeResult(SyncActionStatus.REBASE_IN_PROGRESS);
          }

          if (_.isUndefined(await git.getUpstream()))
            return makeResult(SyncActionStatus.NO_UPSTREAM);
          if (!(await git.hasAccessToRemote()))
            return makeResult(SyncActionStatus.BAD_REMOTE);
          // If the vault was configured not to pull, then skip it
          if (!(await this.shouldVaultsSync("pull", rootVaults)))
            return makeResult(SyncActionStatus.SKIP_CONFIG);

          // If there are tracked changes, we need to stash them to pull
          let stashed: string | undefined;
          if (await git.hasChanges({ untrackedFiles: "no" })) {
            try {
              stashed = await git.stashCreate();
              this.logger.info({ ctx, vaults, repo, stashed });
              // this shouldn't fail, but for safety's sake
              if (_.isEmpty(stashed) || !git.isValidStashCommit(stashed)) {
                throw new DendronError({
                  message: "unable to stash changes",
                  payload: { stashed },
                });
              }
              // stash create doesn't change the working directory, so we need to get rid of the tracked changes
              await git.reset("hard");
            } catch (err: any) {
              this.logger.error({
                ctx: "pullVaults",
                vaults,
                repo,
                err,
                stashed,
              });
              return makeResult(SyncActionStatus.CANT_STASH);
            }
          }
          try {
            await git.pull();
            if (stashed) {
              const restored = await git.stashApplyCommit(stashed);
              stashed = undefined;
              if (!restored)
                return makeResult(
                  SyncActionStatus.MERGE_CONFLICT_AFTER_RESTORE
                );
            }
            // pull went well, everything is in order. The finally block will restore any stashed changes.
            return makeResult(SyncActionStatus.DONE);
          } catch (err: any) {
            // Failed to pull, let's see why:
            if (
              (await git.hasMergeConflicts()) ||
              (await git.hasRebaseInProgress())
            ) {
              if (stashed) {
                // There was a merge conflict during the pull, and we have stashed changes.
                // We can't apply the stash in this state, so we'd lose the users changes.
                // Abort the rebase.
                await git.rebaseAbort();
                return makeResult(
                  SyncActionStatus.MERGE_CONFLICT_LOSES_CHANGES
                );
              } else {
                return makeResult(SyncActionStatus.MERGE_CONFLICT_AFTER_PULL);
              }
            } else {
              const stderr = err?.stderr || "";
              const vaultNames = vaults
                .map((vault) => VaultUtils.getName(vault))
                .join(",");
              throw new DendronError({
                message: `Failed to pull ${vaultNames}: ${stderr}`,
                payload: {
                  err,
                  vaults,
                  repo,
                  stashed,
                },
              });
            }
          } finally {
            // Try to restore changes if we stashed them, even if there were errors. We don't want to lose the users changes.
            if (stashed) {
              git.stashApplyCommit(stashed);
            }
          }
        }
      )
    );
    return out;
  }

  /** Returns the list of vaults that were attempted to be pushed, even if there was nothing to push. */
  async pushVaults(): Promise<SyncActionResult[]> {
    const allReposVaults = await this.getAllReposVaults();
    const out = await Promise.all(
      _.map(
        [...allReposVaults.entries()],
        async (rootVaults: [string, DVault[]]): Promise<SyncActionResult> => {
          const [repo, vaults] = rootVaults;
          const git = new Git({ localUrl: repo });
          const makeResult = (status: SyncActionStatus) => {
            return {
              repo,
              vaults,
              status,
            };
          };

          if (!(await this.shouldVaultsSync("push", rootVaults)))
            return makeResult(SyncActionStatus.SKIP_CONFIG);
          if (!(await git.hasRemote()))
            return { repo, vaults, status: SyncActionStatus.NO_REMOTE };
          // if there's a rebase in progress then there's no upstream, so it needs to come first
          if (await git.hasMergeConflicts()) {
            return makeResult(SyncActionStatus.MERGE_CONFLICT);
          }
          if (await git.hasRebaseInProgress()) {
            return makeResult(SyncActionStatus.REBASE_IN_PROGRESS);
          }
          const upstream = await git.getUpstream();
          if (_.isUndefined(upstream))
            return makeResult(SyncActionStatus.NO_UPSTREAM);
          if (!(await git.hasAccessToRemote()))
            return makeResult(SyncActionStatus.BAD_REMOTE);
          if (!(await git.hasPushableChanges(upstream)))
            return makeResult(SyncActionStatus.NO_CHANGES);
          if (!(await git.hasPushableRemote()))
            return makeResult(SyncActionStatus.UNPULLED_CHANGES);
          if (!_.every(_.map(vaults, this.user.canPushVault)))
            return makeResult(SyncActionStatus.NOT_PERMITTED);
          try {
            await git.push();
            return makeResult(SyncActionStatus.DONE);
          } catch (err: any) {
            const stderr = err.stderr ? `: ${err.stderr}` : "";
            throw new DendronError({
              message: `error pushing vault${stderr}`,
              payload: { err, repoPath: repo },
            });
          }
        }
      )
    );
    return out;
  }

  /**
   * Remove all vault caches in workspace
   */
  async removeVaultCaches() {
    const vaults = ConfigUtils.getVaults(this.config);
    await Promise.all(
      vaults.map((vault) => {
        return removeCache(vault2Path({ wsRoot: this.wsRoot, vault }));
      })
    );
  }

  /**
   * See if there's anythign we need to change with the configuration
   */
  async runMigrationsIfNecessary({
    forceUpgrade,
    workspaceInstallStatus,
    currentVersion,
    previousVersion,
    dendronConfig,
    wsConfig,
  }: {
    forceUpgrade?: boolean;
    workspaceInstallStatus: InstallStatus;
    currentVersion: string;
    previousVersion: string;
    dendronConfig: IntermediateDendronConfig;
    wsConfig?: WorkspaceSettings;
  }) {
    let changes: MigrationChangeSetStatus[] = [];

    if (
      MigrationService.shouldRunMigration({
        force: forceUpgrade,
        workspaceInstallStatus,
      })
    ) {
      changes = await MigrationService.applyMigrationRules({
        currentVersion,
        previousVersion,
        dendronConfig,
        wsConfig,
        wsService: this,
        logger: this.logger,
      });
      // if changes were made, use updated changes in subsequent configuration
      if (!_.isEmpty(changes)) {
        const { data } = _.last(changes)!;
        dendronConfig = data.dendronConfig;
      }
    }

    return changes;
  }

  /**
   * Check major version of configuration.
   * Because Dendron workspace relies on major version to be the same, we force a migration if that's not
   * the case
   */
  async runConfigMigrationIfNecessary({
    currentVersion,
    dendronConfig,
  }: {
    currentVersion: string;
    dendronConfig: IntermediateDendronConfig;
  }) {
    let changes: MigrationChangeSetStatus[] = [];
    if (dendronConfig.version !== CURRENT_CONFIG_VERSION) {
      // NOTE: this migration will create a `migration-config` backup file in the user's home directory
      changes = await MigrationService.applyMigrationRules({
        currentVersion,
        previousVersion: "0.83.0", // to force apply
        dendronConfig,
        wsService: this,
        logger: this.logger,
        migrations: [CONFIG_MIGRATIONS],
      });
      // if changes were made, use updated changes in subsequent configuration
      if (!_.isEmpty(changes)) {
        const { data } = _.last(changes)!;
        dendronConfig = data.dendronConfig;
      }
    }

    return changes;
  }

  /**
   * Make sure all vaults are present on file system
   * @param fetchAndPull for repositories that exist, should we also do a fetch? default: false
   * @param skipPrivate skip cloning and pulling of private vaults. default: false
   */
  async syncVaults(opts: {
    config: IntermediateDendronConfig;
    progressIndicator?: () => void;
    urlTransformer?: UrlTransformerFunc;
    fetchAndPull?: boolean;
    skipPrivate?: boolean;
  }) {
    const ctx = "syncVaults";
    const { config, progressIndicator, urlTransformer, fetchAndPull } =
      _.defaults(opts, { fetchAndPull: false, skipPrivate: false });
    const { wsRoot } = this;

    const workspaces = ConfigUtils.getWorkspace(config).workspaces;
    // check workspaces
    const workspacePaths: { wsPath: string; wsUrl: string }[] = (
      await Promise.all(
        _.map(workspaces, async (wsEntry, wsName) => {
          const wsPath = path.join(wsRoot, wsName);
          if (!fs.existsSync(wsPath)) {
            return {
              wsPath: await this.cloneWorkspace({
                wsName,
                workspace: wsEntry!,
                wsRoot,
              }),
              wsUrl: wsEntry!.remote.url,
            };
          }
          return;
        })
      )
    ).filter((ent) => !_.isUndefined(ent)) as {
      wsPath: string;
      wsUrl: string;
    }[];

    // const seedService = new SeedService({wsRoot});
    // check seeds
    const seeds = ConfigUtils.getWorkspace(config).seeds;
    const seedResults: { id: string; status: SyncActionStatus; data: any }[] =
      [];
    await Promise.all(
      _.map(seeds, async (entry: SeedEntry, id: string) => {
        if (!(await SeedUtils.exists({ id, wsRoot }))) {
          const resp = await this._seedService.info({ id });
          if (_.isUndefined(resp)) {
            seedResults.push({
              id,
              status: SyncActionStatus.ERROR,
              data: new DendronError({
                status: SyncActionStatus.ERROR,
                message: `seed ${id} does not exist in registry`,
              }),
            });
            return;
          }
          const spath = await this._seedService.cloneSeed({
            seed: resp,
            branch: entry.branch,
          });
          seedResults.push({
            id,
            status: SyncActionStatus.NEW,
            data: { spath },
          });
        }
        return undefined;
      })
    );

    // clone all missing vaults
    const vaults = ConfigUtils.getVaults(config);
    const emptyRemoteVaults = vaults.filter(
      (vault) =>
        !_.isUndefined(vault.remote) &&
        !fs.existsSync(vault2Path({ vault, wsRoot }))
    );
    const didClone =
      !_.isEmpty(emptyRemoteVaults) ||
      !_.isEmpty(workspacePaths) ||
      !_.isUndefined(
        seedResults.find((ent) => ent.status === SyncActionStatus.NEW)
      );
    // if we added a workspace, we also add new vaults
    if (!_.isEmpty(workspacePaths)) {
      await this.setConfig(config);
    }
    if (progressIndicator && didClone) {
      progressIndicator();
    }
    await Promise.all(
      emptyRemoteVaults.map(async (vault) => {
        return this.cloneVault({ vault, urlTransformer });
      })
    );
    if (fetchAndPull) {
      const vaults = ConfigUtils.getVaults(config);
      const vaultsToFetch = _.difference(
        vaults.filter((vault) => !_.isUndefined(vault.remote)),
        emptyRemoteVaults
      );
      this.logger.info({ ctx, msg: "fetching vaults", vaultsToFetch });
      await Promise.all(
        vaultsToFetch.map(async (vault) => {
          return this.pullVault({ vault });
        })
      );
    }
    return { didClone };
  }

  writePort(port: number) {
    const wsRoot = this.wsRoot;
    // dendron-cli can overwrite port file. anything that needs the port should connect to `portFilePathExtension`
    const portFilePath = EngineUtils.getPortFilePathForWorkspace({ wsRoot });
    fs.writeFileSync(portFilePath, _.toString(port), { encoding: "utf8" });
  }

  writeMeta(opts: { version: string }) {
    const { version } = opts;
    const fpath = getWSMetaFilePath({ wsRoot: this.wsRoot });
    return writeWSMetaFile({
      fpath,
      data: {
        version,
        activationTime: Time.now().toMillis(),
      },
    });
  }
}
