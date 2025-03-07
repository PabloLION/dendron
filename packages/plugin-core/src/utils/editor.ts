import {
  DECORATION_TYPES,
  DEngineClient,
  genUUIDInsecure,
} from "@dendronhq/common-all";
import {
  DendronASTDest,
  DendronASTTypes,
  select,
  Heading,
  BlockAnchor,
  MDUtilsV5,
  ProcMode,
  AnchorUtils,
  WikiLinkNoteV4,
  UserTag,
  HashTag,
  linkedNoteType,
  MdastUtils,
} from "@dendronhq/engine-server";
import _ from "lodash";
import vscode, {
  Position,
  Selection,
  TextDocument,
  TextEditor,
  TextEditorEdit,
} from "vscode";
import { ExtensionProvider } from "../ExtensionProvider";
import { VSCodeUtils } from "../vsCodeUtils";
import { WSUtils } from "../WSUtils";

export function isAnythingSelected(): boolean {
  return !vscode.window?.activeTextEditor?.selection?.isEmpty;
}

/** Finds the header at the specified line, if any.
 *
 * @param editor the editor that has the document containing the header open
 * @param position the line where the header should be checked for
 * @returns the header text, or undefined if there wasn't a header
 */
export function getHeaderAt({
  document,
  position,
  engine: _engine,
}: {
  document: TextDocument;
  position: Position;
  engine?: DEngineClient;
}): undefined | string {
  const line = document.lineAt(position.line);
  const headerLine = _.trim(line.text);
  if (headerLine.startsWith("#")) {
    const proc = MDUtilsV5.procRemarkParse({ mode: ProcMode.NO_DATA }, {});
    const parsed = proc.parse(headerLine);
    const header = select(DendronASTTypes.HEADING, parsed) as Heading | null;
    if (_.isNull(header)) return undefined;
    const headerText = AnchorUtils.headerText(header);
    if (headerText.length === 0) return undefined;
    return headerText;
  } else {
    return undefined;
  }
}

/** Finds the block anchor at the end of the specified line, if any.
 *
 * @param editor the editor that has the document containing the anchor open
 * @param position the line where the anchor should be checked for
 * @returns the anchor (with ^), or undefined if there wasn't an anchor
 */
export function getBlockAnchorAt({
  editor,
  position,
}: {
  editor: TextEditor;
  position: Position;
  engine?: DEngineClient;
}): string | undefined {
  const line = editor.document.lineAt(position.line);
  const proc = MDUtilsV5.procRemarkParseNoData(
    {},
    { dest: DendronASTDest.MD_DENDRON }
  );
  const parsed = proc.parse(_.trim(line.text));
  const blockAnchor = select(
    DendronASTTypes.BLOCK_ANCHOR,
    parsed
  ) as BlockAnchor | null;

  if (_.isNull(blockAnchor) || !blockAnchor.id) return undefined;
  return `^${blockAnchor.id}`;
}

/** Add a block anchor at the end of the specified line. The anchor is randomly generated if not supplied.
 *
 * If there is already an anchor at the end of this line, then this function doesn't actually insert an anchor but returns that anchor instead.
 *
 * @param editBuilder parameter of the callback in `editor.edit`
 * @param editor the editor that the editBuilder belongs to
 * @param position the line where the anchor will be inserted
 * @param anchor anchor id to insert (without ^), randomly generated if undefined
 * @returns the anchor that has been added (with ^)
 */
export function addOrGetAnchorAt(opts: {
  editBuilder: TextEditorEdit;
  editor: TextEditor;
  position: Position;
  anchor?: string;
  engine: DEngineClient;
}) {
  const { editBuilder, editor, position } = opts;
  let { anchor } = opts;
  const line = editor.document.lineAt(position.line);
  const existingAnchor = getAnchorAt(opts);
  if (!_.isUndefined(existingAnchor)) return existingAnchor;
  if (_.isUndefined(anchor)) anchor = genUUIDInsecure();
  editBuilder.insert(line.range.end, ` ^${anchor}`);
  return `^${anchor}`;
}

/** Finds the header or block anchor at the end of the specified line, if any.
 *
 * @param editor the editor that has the document containing the anchor open
 * @param position the line where the anchor should be checked for
 * @returns the anchor (with ^), or undefined if there wasn't an anchor
 */
export function getAnchorAt(args: {
  editor: TextEditor;
  position: Position;
  engine: DEngineClient;
}): string | undefined {
  const { editor } = args;
  return (
    getHeaderAt({ document: editor.document, ...args }) ||
    getBlockAnchorAt(args)
  );
}

export async function getSelectionAnchors(opts: {
  editor: TextEditor;
  selection?: Selection;
  doStartAnchor?: boolean;
  doEndAnchor?: boolean;
  engine: DEngineClient;
}): Promise<{ startAnchor?: string; endAnchor?: string }> {
  const { editor, selection, doStartAnchor, doEndAnchor, engine } = _.defaults(
    opts,
    { doStartAnchor: true, doEndAnchor: true }
  );
  if (_.isUndefined(selection)) return {};
  const { start, end } = selection;

  // first check if there's an existing anchor
  let startAnchor = doStartAnchor
    ? getAnchorAt({ editor, position: start, engine })
    : undefined;

  // does the user have only a single
  const singleLine =
    // single line selected
    start.line === end.line ||
    // the first line selected in full, nothing on second line (default behavior when double clicking on a line)
    (start.line + 1 === end.line && end.character === 0);
  // does the user have any amount of text selected?
  const hasSelectedRegion =
    start.line !== end.line || start.character !== end.character;

  // first check if there's an existing anchor
  let endAnchor: string | undefined;
  if (!singleLine && doEndAnchor)
    endAnchor = getAnchorAt({ editor, position: end, engine });

  // if we found both anchors already, just return them.
  if (!_.isUndefined(startAnchor) && !_.isUndefined(endAnchor))
    return { startAnchor, endAnchor };

  // otherwise, we'll need to edit the document to insert block anchors
  await editor.edit((editBuilder) => {
    if (_.isUndefined(startAnchor) && doStartAnchor && hasSelectedRegion)
      startAnchor = addOrGetAnchorAt({
        editBuilder,
        editor,
        position: start,
        engine,
      });
    if (_.isUndefined(endAnchor) && doEndAnchor && !singleLine)
      endAnchor = addOrGetAnchorAt({
        editBuilder,
        editor,
        position: end,
        engine,
      });
  });
  return { startAnchor, endAnchor };
}

/**
 * Utility method to check if the selected text is a broken wikilink
 */
export async function isBrokenWikilink(): Promise<boolean> {
  const { editor, selection } = VSCodeUtils.getSelection();
  if (!editor || !selection) return false;
  const note = WSUtils.getNoteFromDocument(editor.document);
  const { engine } = ExtensionProvider.getDWorkspace();
  if (!note) return false;
  const line = editor.document.lineAt(selection.start.line).text;
  const proc = MDUtilsV5.procRemarkParse(
    { mode: ProcMode.FULL },
    {
      dest: DendronASTDest.MD_DENDRON,
      engine,
      vault: note.vault,
      fname: note.fname,
    }
  );
  const parsedLine = proc.parse(line);
  let link: WikiLinkNoteV4 | UserTag | HashTag | undefined;
  let type: DECORATION_TYPES | undefined;
  let fname: string;
  await MdastUtils.visitAsync(
    parsedLine,
    [
      DendronASTTypes.WIKI_LINK,
      DendronASTTypes.USERTAG,
      DendronASTTypes.HASHTAG,
    ],
    async (linkvalue) => {
      link = linkvalue as WikiLinkNoteV4 | UserTag | HashTag;
      if (!link) return false;
      fname = link.type === DendronASTTypes.WIKI_LINK ? link.value : link.fname;
      type = (await linkedNoteType({ fname, engine })).type;
      return false;
    }
  );
  return type === DECORATION_TYPES.brokenWikilink;
}
