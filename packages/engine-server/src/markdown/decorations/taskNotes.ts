import {
  ConfigUtils,
  DEngine,
  NoteUtils,
  TaskNoteUtils,
  VaultUtils,
  VSRange,
} from "@dendronhq/common-all";
import _ from "lodash";
import { Decoration, DECORATION_TYPES } from "./utils";

export type DecorationTaskNote = Decoration & {
  type: DECORATION_TYPES.taskNote;
  beforeText?: string;
  afterText?: string;
};

/** Decorates the note `fname` in vault `vaultName` if the note is a task note. */
export function decorateTaskNote({
  engine,
  range,
  fname,
  vaultName,
}: {
  engine: DEngine;
  range: VSRange;
  fname: string;
  vaultName?: string;
}) {
  const { vaults, config } = engine;
  const taskConfig = ConfigUtils.getTask(config);
  const vault = vaultName
    ? VaultUtils.getVaultByName({ vname: vaultName, vaults })
    : undefined;

  const note = NoteUtils.getNotesByFnameFromEngine({
    fname,
    vault,
    engine,
  })[0];
  if (!note || !TaskNoteUtils.isTaskNote(note)) return;

  // Determines whether the task link is preceded by an empty or full checkbox
  const status = TaskNoteUtils.getStatusSymbol({ note, taskConfig });

  const { due, owner, priority } = note.custom;
  const decorationString: string[] = [];
  if (due) decorationString.push(`due:${due}`);
  if (owner) decorationString.push(`@${owner}`);
  if (priority) {
    const prioritySymbol = TaskNoteUtils.getPrioritySymbol({
      note,
      taskConfig,
    });
    if (prioritySymbol) decorationString.push(`priority:${prioritySymbol}`);
  }
  if (note.tags) {
    const tags = _.isString(note.tags) ? [note.tags] : note.tags;
    decorationString.push(...tags.map((tag) => `#${tag}`));
  }

  const decoration: DecorationTaskNote = {
    type: DECORATION_TYPES.taskNote,
    range,
    beforeText: status ? `${status} ` : undefined,
    afterText:
      decorationString.length > 0
        ? ` ${decorationString.join(" ")}`
        : undefined,
  };
  return decoration;
}
