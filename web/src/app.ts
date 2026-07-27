import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import type { ChangedFile, FileContents, HostMessage, ReviewComment, ReviewMode, WorkspaceState } from "../../src/types.js";

declare global {
  interface Window {
    glimpse?: { send(message: unknown): void };
    __reviewReceive(message: HostMessage): void;
    __reviewWorkerSource: string;
    MonacoEnvironment: { getWorker(): Worker };
  }
}

let workerUrl: string | null = null;
window.MonacoEnvironment = {
  getWorker: () => {
    workerUrl ??= URL.createObjectURL(new Blob([window.__reviewWorkerSource], { type: "text/javascript" }));
    return new Worker(workerUrl);
  },
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element == null) throw new Error(`Missing #${id}`);
  return element as T;
};

const repoNameEl = byId("repo-name");
const repoMetaEl = byId("repo-meta");
const checkpointButton = byId<HTMLButtonElement>("mode-checkpoint");
const headButton = byId<HTMLButtonElement>("mode-head");
const submitButton = byId<HTMLButtonElement>("submit-review");
const searchInput = byId<HTMLInputElement>("search");
const recentCountEl = byId("recent-count");
const fileCountEl = byId("file-count");
const recentListEl = byId("recent-list");
const fileTreeEl = byId("file-tree");
const filePathEl = byId("file-path");
const fileStatusEl = byId("file-status");
const lineWrapButton = byId<HTMLButtonElement>("line-wrap");
const fileCommentButton = byId<HTMLButtonElement>("file-comment");
const emptyStateEl = byId("empty-state");
const editorEl = byId("editor");
const feedbackPanelEl = byId("feedback-panel");
const feedbackTitleEl = byId("feedback-title");
const commentListEl = byId("comment-list");
const draftRowEl = byId("draft-row");
const draftLocationEl = byId("draft-location");
const draftInput = byId<HTMLTextAreaElement>("draft-input");
const addCommentButton = byId<HTMLButtonElement>("add-comment");
const cancelDraftButton = byId<HTMLButtonElement>("cancel-draft");
const toastEl = byId("toast");

let workspace: WorkspaceState | null = null;
let activePath: string | null = null;
let mountedFingerprint = "";
let mountedPath: string | null = null;
let mountedMode: ReviewMode | null = null;
const scrollPositions = new Map<string, ScrollPosition>();
let activeRequestId = "";
let requestCounter = 0;
interface UiComment extends ReviewComment { id: string }
interface ActiveViewZone { id: string; editor: monaco.editor.ICodeEditor; domNode: HTMLElement }
interface ScrollPosition {
  originalTop: number;
  originalLeft: number;
  modifiedTop: number;
  modifiedLeft: number;
}

let comments: UiComment[] = [];
let draft: Omit<UiComment, "body" | "id"> | null = null;
let activeViewZones: ActiveViewZone[] = [];
let pendingOpenPath: string | null = null;
let toastTimer = 0;
let readyTimer = 0;
const collapsedDirs = new Set<string>();

monaco.editor.defineTheme("review-loop", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "667085" },
    { token: "keyword", foreground: "BB9AF7" },
    { token: "string", foreground: "9ECE6A" },
    { token: "number", foreground: "FF9E64" },
    { token: "type", foreground: "7DCFFF" },
  ],
  colors: {
    "editor.background": "#0d1016",
    "editorGutter.background": "#0d1016",
    "editorLineNumber.foreground": "#465064",
    "editorLineNumber.activeForeground": "#9aa5b5",
    "editor.selectionBackground": "#33415c88",
    "editor.lineHighlightBackground": "#151a23",
    "diffEditor.insertedTextBackground": "#2d6a4f38",
    "diffEditor.removedTextBackground": "#8f3a4b38",
    "diffEditor.insertedLineBackground": "#19382c55",
    "diffEditor.removedLineBackground": "#41212a55",
    "diffEditor.diagonalFill": "#202734",
    "scrollbarSlider.background": "#30394988",
    "scrollbarSlider.hoverBackground": "#3d485bAA",
    "editorOverviewRuler.border": "#00000000",
  },
});
monaco.editor.setTheme("review-loop");

const diffEditor = monaco.editor.createDiffEditor(editorEl, {
  readOnly: true,
  originalEditable: false,
  automaticLayout: true,
  renderSideBySide: true,
  enableSplitViewResizing: true,
  minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
  glyphMargin: true,
  folding: true,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 8,
  scrollBeyondLastLine: false,
  renderOverviewRuler: true,
  overviewRulerLanes: 3,
  overviewRulerBorder: false,
  wordWrap: "off",
  diffWordWrap: "off",
  hideUnchangedRegions: { enabled: false },
  padding: { top: 8, bottom: 8 },
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  lineHeight: 19,
});

let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let originalDecorations: string[] = [];
let modifiedDecorations: string[] = [];

function send(message: unknown): void {
  window.glimpse?.send(message);
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  toastTimer = window.setTimeout(() => toastEl.classList.remove("visible"), 2200);
}

function statusLetter(status: ChangedFile["status"]): string {
  return status === "modified" ? "M" : status === "added" ? "A" : "D";
}

function statusSpan(file: ChangedFile): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `status ${file.status}`;
  span.textContent = statusLetter(file.status);
  return span;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function relativeTime(value?: number): string {
  if (!value) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function matches(file: ChangedFile): boolean {
  const query = searchInput.value.trim().toLowerCase();
  return !query || file.path.toLowerCase().includes(query);
}

function scrollKey(path: string, mode: ReviewMode): string {
  return `${mode}:${path}`;
}

function saveMountedScroll(): void {
  if (mountedPath == null || mountedMode == null || originalModel == null || modifiedModel == null) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  scrollPositions.set(scrollKey(mountedPath, mountedMode), {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  });
}

function restoreScroll(path: string, mode: ReviewMode): void {
  const position = scrollPositions.get(scrollKey(path, mode)) ?? {
    originalTop: 0,
    originalLeft: 0,
    modifiedTop: 0,
    modifiedLeft: 0,
  };
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollPosition({ scrollTop: position.originalTop, scrollLeft: position.originalLeft });
  modifiedEditor.setScrollPosition({ scrollTop: position.modifiedTop, scrollLeft: position.modifiedLeft });
}

function selectPath(path: string, preferCheckpoint = false): void {
  if (workspace == null) return;
  const inCurrentMode = workspace.files.some((file) => file.path === path);
  if (!inCurrentMode && preferCheckpoint && workspace.mode !== "checkpoint") {
    saveMountedScroll();
    pendingOpenPath = path;
    send({ type: "set-mode", mode: "checkpoint" });
    return;
  }
  if (!inCurrentMode) return;
  saveMountedScroll();
  clearViewZones();
  activePath = path;
  mountedFingerprint = "";
  render();
  requestActiveFile();
}

function makeCommentId(): string {
  return `comment:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function isPendingReview(path: string): boolean {
  return workspace?.pendingFiles.some((file) => file.path === path) ?? false;
}

function commentCount(path: string): number {
  return comments.filter((comment) => comment.path === path).length;
}

function commentBadge(path: string): HTMLSpanElement | null {
  const count = commentCount(path);
  if (count === 0) return null;
  const badge = document.createElement("span");
  badge.className = "comment-count";
  badge.textContent = String(count);
  badge.title = `${count} review comment${count === 1 ? "" : "s"}`;
  return badge;
}

function makeRecentRow(file: ChangedFile): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `file-row${file.path === activePath ? " active" : ""}`;
  button.append(statusSpan(file));
  const copy = document.createElement("span");
  copy.className = "copy";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = basename(file.path);
  const pathParent = document.createElement("span");
  pathParent.className = "parent";
  pathParent.textContent = parent(file.path);
  copy.append(name, pathParent);
  const time = document.createElement("time");
  time.textContent = relativeTime(file.recentAt);
  button.append(copy);
  const badge = commentBadge(file.path);
  if (badge) button.append(badge);
  if (workspace?.mode === "head" && !isPendingReview(file.path)) {
    const reviewed = document.createElement("span");
    reviewed.className = "reviewed-check";
    reviewed.textContent = "✓";
    reviewed.title = "Matches the last reviewed checkpoint";
    button.append(reviewed);
  }
  button.append(time);
  button.addEventListener("click", () => selectPath(file.path, true));
  return button;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: ChangedFile;
}

function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    let path = "";
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      let child = node.children.get(name);
      if (child == null) {
        child = { name, path, children: new Map() };
        node.children.set(name, child);
      }
      if (index === parts.length - 1) child.file = file;
      node = child;
    });
  }
  return root;
}

function appendTree(node: TreeNode, depth: number): void {
  const children = [...node.children.values()].sort((a, b) => {
    if (!!a.file !== !!b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const child of children) {
    if (child.file) {
      const row = document.createElement("button");
      row.className = `tree-row${child.file.path === activePath ? " active" : ""}`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.append(statusSpan(child.file));
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = child.name;
      row.append(label);
      const badge = commentBadge(child.file.path);
      if (badge) row.append(badge);
      if (isPendingReview(child.file.path)) {
        const dot = document.createElement("span");
        dot.className = "recent-dot";
        dot.title = "Changed since the last review";
        row.append(dot);
      } else if (workspace?.mode === "head") {
        const reviewed = document.createElement("span");
        reviewed.className = "reviewed-check";
        reviewed.textContent = "✓";
        reviewed.title = "Matches the last reviewed checkpoint";
        row.append(reviewed);
      }
      row.addEventListener("click", () => selectPath(child.file!.path));
      fileTreeEl.append(row);
      continue;
    }

    const collapsed = collapsedDirs.has(child.path);
    const row = document.createElement("button");
    row.className = "tree-row directory";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = collapsed ? "▶" : "▼";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = child.name;
    row.append(chevron, label);
    row.addEventListener("click", () => {
      collapsed ? collapsedDirs.delete(child.path) : collapsedDirs.add(child.path);
      renderTree();
    });
    fileTreeEl.append(row);
    if (!collapsed) appendTree(child, depth + 1);
  }
}

function renderRecent(): void {
  if (workspace == null) return;
  recentListEl.replaceChildren();
  const activeFiles = new Map(workspace.files.map((file) => [file.path, file]));
  const files = workspace.recentPaths.map((path) => activeFiles.get(path)).filter((file): file is ChangedFile => file != null).filter(matches);
  recentCountEl.textContent = files.length ? String(files.length) : "";
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = workspace.files.length ? "No recent matches" : workspace.mode === "checkpoint" ? "No new changes" : "Working tree is clean";
    recentListEl.append(empty);
    return;
  }
  files.forEach((file) => recentListEl.append(makeRecentRow(file)));
}

function renderTree(): void {
  if (workspace == null) return;
  fileTreeEl.replaceChildren();
  const files = workspace.files.filter(matches);
  fileCountEl.textContent = String(files.length);
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = searchInput.value ? "No matching files" : workspace.mode === "checkpoint" ? "Nothing since the last review" : "Working tree is clean";
    fileTreeEl.append(empty);
    return;
  }
  appendTree(buildTree(files), 0);
}

function updateSubmitButton(): void {
  const count = workspace?.pendingFiles.length ?? 0;
  const commentCount = comments.filter((comment) => comment.body.trim().length > 0).length;
  submitButton.disabled = count === 0 && commentCount === 0;
  if (commentCount > 0) submitButton.textContent = `Submit ${commentCount} comment${commentCount === 1 ? "" : "s"} · review ${count}`;
  else if (count > 0) submitButton.textContent = `Mark ${count} reviewed`;
  else submitButton.textContent = "Mark reviewed";
}

function updateHeader(): void {
  if (workspace == null) return;
  repoNameEl.textContent = workspace.repoName;
  const baseline = workspace.hasCheckpoint && workspace.checkpointCreatedAt
    ? `reviewed ${relativeTime(workspace.checkpointCreatedAt)} ago`
    : "not reviewed yet";
  repoMetaEl.textContent = [workspace.branch, baseline].filter(Boolean).join(" · ");
  checkpointButton.classList.toggle("active", workspace.mode === "checkpoint");
  headButton.classList.toggle("active", workspace.mode === "head");
}

function activeFile(): ChangedFile | null {
  return workspace?.files.find((file) => file.path === activePath) ?? null;
}

function renderFilebar(): void {
  const file = activeFile();
  fileStatusEl.className = file ? `status ${file.status}` : "status";
  fileStatusEl.textContent = file ? statusLetter(file.status) : "";
  filePathEl.textContent = file?.path ?? "No changes to review";
  lineWrapButton.disabled = file == null;
  fileCommentButton.disabled = file == null;
}

function render(): void {
  if (workspace == null) return;
  updateHeader();
  renderRecent();
  renderTree();
  renderFilebar();
  updateSubmitButton();

  const file = activeFile();
  emptyStateEl.classList.toggle("hidden", file != null);
  editorEl.classList.toggle("hidden", file == null);
  if (file == null) disposeModels();
  renderFeedback();
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", html: "html", htm: "html", md: "markdown", py: "python", rs: "rust",
    go: "go", java: "java", kt: "kotlin", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
  } as Record<string, string>)[ext ?? ""] ?? "plaintext";
}

function clearViewZones(): void {
  if (activeViewZones.length === 0) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.changeViewZones((accessor) => {
    activeViewZones.filter((zone) => zone.editor === originalEditor).forEach((zone) => accessor.removeZone(zone.id));
  });
  modifiedEditor.changeViewZones((accessor) => {
    activeViewZones.filter((zone) => zone.editor === modifiedEditor).forEach((zone) => accessor.removeZone(zone.id));
  });
  activeViewZones = [];
}

function disposeModels(): void {
  saveMountedScroll();
  clearViewZones();
  diffEditor.setModel(null);
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
  mountedFingerprint = "";
  mountedPath = null;
  mountedMode = null;
}

function mountFile(file: FileContents): void {
  if (file.path !== activePath || workspace?.mode !== file.mode) return;
  disposeModels();
  const language = inferLanguage(file.path);
  originalModel = monaco.editor.createModel(file.originalContent, language);
  modifiedModel = monaco.editor.createModel(file.modifiedContent, language);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  mountedFingerprint = file.fingerprint;
  mountedPath = file.path;
  mountedMode = file.mode;
  syncInlineComments();
  requestAnimationFrame(() => {
    restoreScroll(file.path, file.mode);
    setTimeout(() => restoreScroll(file.path, file.mode), 30);
  });
}

function requestActiveFile(): void {
  const file = activeFile();
  if (file == null || file.fingerprint === mountedFingerprint) return;
  activeRequestId = `file:${++requestCounter}`;
  send({ type: "request-file", requestId: activeRequestId, path: file.path, mode: workspace!.mode });
}

function commentSideLabel(comment: ReviewComment): string {
  if (comment.side === "modified") return "Current";
  return comment.mode === "head" ? "HEAD" : "Reviewed";
}

function commentLocation(comment: ReviewComment): string {
  if (comment.side === "file" || comment.line == null) return comment.path;
  return `${comment.path}:${comment.line} ${commentSideLabel(comment).toLowerCase()}`;
}

function removeComment(id: string): void {
  comments = comments.filter((comment) => comment.id !== id);
  renderFeedback();
  renderRecent();
  renderTree();
  updateSubmitButton();
  syncInlineComments();
}

function renderFeedback(): void {
  const fileComments = comments.filter((comment) => comment.side === "file" && comment.path === activePath && comment.mode === workspace?.mode);
  const visible = fileComments.length > 0 || draft != null;
  feedbackPanelEl.classList.toggle("hidden", !visible);
  feedbackTitleEl.textContent = fileComments.length ? `File notes · ${fileComments.length}` : "File note";
  commentListEl.replaceChildren();
  fileComments.forEach((comment) => {
    const row = document.createElement("div");
    row.className = "comment";
    const location = document.createElement("div");
    location.className = "comment-location";
    location.textContent = commentLocation(comment);
    location.title = commentLocation(comment);
    const body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = comment.body;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Delete note";
    remove.addEventListener("click", () => removeComment(comment.id));
    row.append(location, body, remove);
    commentListEl.append(row);
  });

  draftRowEl.classList.toggle("hidden", draft == null);
  cancelDraftButton.classList.toggle("hidden", draft == null);
  if (draft != null) draftLocationEl.textContent = commentLocation({ ...draft, body: "" });
}

function openFileDraft(): void {
  if (activePath == null || workspace == null) return;
  draft = { path: activePath, mode: workspace.mode, side: "file", line: null };
  draftInput.value = "";
  renderFeedback();
  requestAnimationFrame(() => draftInput.focus());
}

function addDraft(): void {
  const body = draftInput.value.trim();
  if (draft == null || !body) return;
  comments.push({ ...draft, id: makeCommentId(), body });
  draft = null;
  draftInput.value = "";
  renderFeedback();
  renderRecent();
  renderTree();
  updateSubmitButton();
}

function renderDecorations(): void {
  const pathComments = comments.filter((comment) => comment.path === activePath && comment.mode === workspace?.mode && comment.line != null && comment.side !== "file");
  const original = pathComments.filter((comment) => comment.side === "original").map((comment) => ({
    range: new monaco.Range(comment.line!, 1, comment.line!, 1),
    options: { isWholeLine: true, className: "review-comment-line", glyphMarginClassName: "review-comment-glyph" },
  }));
  const modified = pathComments.filter((comment) => comment.side === "modified").map((comment) => ({
    range: new monaco.Range(comment.line!, 1, comment.line!, 1),
    options: { isWholeLine: true, className: "review-comment-line", glyphMarginClassName: "review-comment-glyph" },
  }));
  if (originalModel) originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, original);
  if (modifiedModel) modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modified);
}

function sizeInlineComment(container: HTMLElement, editor: monaco.editor.ICodeEditor): void {
  const width = editor.getLayoutInfo().contentWidth;
  container.style.width = `${width}px`;
  container.style.maxWidth = `${width}px`;
}

function inlineCommentElement(comment: UiComment, editor: monaco.editor.ICodeEditor): HTMLElement {
  const container = document.createElement("div");
  container.className = "inline-comment";
  sizeInlineComment(container, editor);
  const header = document.createElement("div");
  header.className = "inline-comment-header";
  const title = document.createElement("strong");
  title.textContent = `${commentSideLabel(comment)} line ${comment.line}`;
  const remove = document.createElement("button");
  remove.textContent = "Delete";
  remove.addEventListener("click", () => removeComment(comment.id));
  header.append(title, remove);

  const textarea = document.createElement("textarea");
  textarea.dataset.commentId = comment.id;
  textarea.rows = 3;
  textarea.placeholder = "Leave actionable feedback…";
  textarea.value = comment.body;
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
    updateSubmitButton();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") textarea.blur();
    if (event.key === "Escape" && comment.body.trim().length === 0) removeComment(comment.id);
  });
  container.append(header, textarea);
  if (!comment.body) setTimeout(() => textarea.focus(), 20);
  return container;
}

function syncInlineComments(): void {
  clearViewZones();
  if (!originalModel || !modifiedModel || activePath == null || workspace == null) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = comments.filter((comment) =>
    comment.path === activePath && comment.mode === workspace!.mode && comment.side !== "file" && comment.line != null,
  );
  inlineComments.forEach((comment) => {
    const editor = comment.side === "original" ? originalEditor : modifiedEditor;
    const maxLine = editor.getModel()?.getLineCount() ?? comment.line!;
    editor.changeViewZones((accessor) => {
      const domNode = inlineCommentElement(comment, editor);
      const id = accessor.addZone({
        afterLineNumber: Math.min(comment.line!, maxLine),
        heightInPx: 128,
        domNode,
      });
      activeViewZones.push({ id, editor, domNode });
    });
  });
  renderDecorations();
}

function addInlineComment(side: "original" | "modified", line: number): void {
  if (activePath == null || workspace == null) return;
  const existing = comments.find((comment) => comment.path === activePath && comment.mode === workspace!.mode && comment.side === side && comment.line === line);
  if (existing) {
    document.querySelector<HTMLTextAreaElement>(`textarea[data-comment-id="${existing.id}"]`)?.focus();
    return;
  }
  comments.push({ id: makeCommentId(), path: activePath, mode: workspace.mode, side, line, body: "" });
  renderRecent();
  renderTree();
  updateSubmitButton();
  syncInlineComments();
  const editor = side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  editor.revealLineInCenter(line);
}

function installGutterComments(editor: monaco.editor.ICodeEditor, side: "original" | "modified"): void {
  let hoverDecorations: string[] = [];
  editor.onMouseMove((event) => {
    const target = event.target;
    const gutter = target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    const line = gutter ? target.position?.lineNumber : undefined;
    hoverDecorations = editor.deltaDecorations(hoverDecorations, line ? [{
      range: new monaco.Range(line, 1, line, 1),
      options: { glyphMarginClassName: "review-glyph-plus" },
    }] : []);
  });
  editor.onMouseLeave(() => {
    hoverDecorations = editor.deltaDecorations(hoverDecorations, []);
  });
  editor.onMouseDown((event) => {
    const target = event.target;
    const gutter = target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    const line = target.position?.lineNumber ?? target.range?.startLineNumber;
    if (!gutter || line == null) return;
    try {
      addInlineComment(side, line);
    } catch (error) {
      showToast(`Could not add comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
const originalEditor = diffEditor.getOriginalEditor();
const modifiedEditor = diffEditor.getModifiedEditor();
installGutterComments(originalEditor, "original");
installGutterComments(modifiedEditor, "modified");
originalEditor.onDidLayoutChange(() => activeViewZones.filter((zone) => zone.editor === originalEditor).forEach((zone) => sizeInlineComment(zone.domNode, originalEditor)));
modifiedEditor.onDidLayoutChange(() => activeViewZones.filter((zone) => zone.editor === modifiedEditor).forEach((zone) => sizeInlineComment(zone.domNode, modifiedEditor)));

window.__reviewReceive = (message: HostMessage): void => {
  if (message.type === "workspace") {
    window.clearInterval(readyTimer);
    saveMountedScroll();
    const previousPath = activePath;
    const previousMode = workspace?.mode;
    workspace = message.state;
    if (pendingOpenPath && workspace.files.some((file) => file.path === pendingOpenPath)) {
      activePath = pendingOpenPath;
      pendingOpenPath = null;
    } else if (!activePath || !workspace.files.some((file) => file.path === activePath)) {
      activePath = workspace.recentPaths.find((path) => workspace!.files.some((file) => file.path === path)) ?? workspace.files[0]?.path ?? null;
    }
    const file = activeFile();
    if (previousPath !== activePath || previousMode !== workspace.mode || file?.fingerprint !== mountedFingerprint) mountedFingerprint = "";
    render();
    requestActiveFile();
    return;
  }
  if (message.type === "file") {
    if (message.requestId === activeRequestId) mountFile(message.file);
    return;
  }
  if (message.type === "file-error") {
    if (message.requestId === activeRequestId) showToast(message.message);
    return;
  }
  if (message.type === "review-submitted") {
    comments = [];
    draft = null;
    submitButton.disabled = false;
    renderFeedback();
    renderRecent();
    renderTree();
    updateSubmitButton();
    syncInlineComments();
    showToast(message.insertedFeedback ? "Checkpoint saved · feedback inserted into pi" : "Checkpoint saved");
  }
};

checkpointButton.addEventListener("click", () => {
  saveMountedScroll();
  send({ type: "set-mode", mode: "checkpoint" as ReviewMode });
});
headButton.addEventListener("click", () => {
  saveMountedScroll();
  send({ type: "set-mode", mode: "head" as ReviewMode });
});
searchInput.addEventListener("input", () => { renderRecent(); renderTree(); });
lineWrapButton.addEventListener("click", () => {
  const enabled = lineWrapButton.getAttribute("aria-pressed") !== "true";
  const wordWrap = enabled ? "on" : "off";
  lineWrapButton.setAttribute("aria-pressed", String(enabled));
  lineWrapButton.classList.toggle("active", enabled);
  lineWrapButton.title = enabled ? "Disable line wrap" : "Enable line wrap";
  // Monaco uses wordWrapOverride1 internally for diffWordWrap. Set the
  // higher-priority override too so both nested editors receive the toggle.
  diffEditor.updateOptions({ diffWordWrap: wordWrap, wordWrapOverride2: wordWrap });
});
fileCommentButton.addEventListener("click", openFileDraft);
addCommentButton.addEventListener("click", addDraft);
cancelDraftButton.addEventListener("click", () => {
  draft = null;
  draftInput.value = "";
  renderFeedback();
});
draftInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    addDraft();
  }
  if (event.key === "Escape") {
    draft = null;
    renderFeedback();
  }
});
submitButton.addEventListener("click", () => {
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  submitButton.textContent = "Saving…";
  send({ type: "submit-review", comments });
  window.setTimeout(() => updateSubmitButton(), 5000);
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
window.setInterval(renderRecent, 10_000);

const announceReady = (): void => {
  if (workspace == null) send({ type: "ready" });
};
announceReady();
readyTimer = window.setInterval(announceReady, 250);
