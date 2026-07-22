# Review Loop

A persistent, incremental diff reviewer for [pi](https://pi.dev).

Review Loop keeps a native review window open while the agent works. Submitting a review records the current workspace as a session-backed checkpoint, so the next review can show only the changes made afterward.

## Install

```sh
pi install git:github.com/earendil-works/pi-review-loop
```

Update an existing installation with:

```sh
pi update --extensions
```

Start pi in a Git repository and open the reviewer:

```text
/diff-review
```

The command returns immediately; it does not replace pi's editor. Running `/diff-review` again brings the existing review window forward.

## Review workflow

1. Open the window with `/diff-review`.
2. Select a file from **Recently Changed** or the **Files** tree.
3. Review its diff.
4. Hover a line number to reveal a `+`, then click it to add an inline comment.
   - The left pane refers to **Reviewed** content in `Since review` mode or **HEAD** in `vs HEAD` mode.
   - The right pane refers to the **Current** on-disk content.
   - Inline comments work on either pane.
5. Use **Add file note** for feedback that is not tied to a line.
6. Comment-count badges appear beside files in both sidebar sections.
7. Click the review button in the top-right.
   - All files currently changed since the checkpoint are marked reviewed, whether or not each file was opened.
   - The current workspace becomes the new review checkpoint.
   - Review feedback is inserted into pi's normal editor.
   - Feedback is **not sent automatically**; inspect or edit it in pi, then submit it normally.
8. Keep the window open. Later changes appear as the next review batch.

Submitting with no comments simply marks the current workspace as reviewed.

## Diff modes

### Since review

Compares:

```text
last review checkpoint → current workspace
```

This is the default review queue. After submitting a review, it becomes empty until files change again.

Before the first checkpoint, the baseline is the `HEAD` captured when Review Loop opens.

### vs HEAD

Compares:

```text
current HEAD → current workspace
```

This shows the complete current working-tree change set, including changes already covered by a review checkpoint. Files that still match the last checkpoint display a green reviewed checkmark; files changed afterward retain the blue pending indicator.

Changing modes does not alter the checkpoint. Submitting a review always checkpoints the current workspace.

## Recently Changed and the file tree

Both sidebar sections follow the active diff mode:

- In **Since review**, they contain files different from the review checkpoint.
- In **vs HEAD**, they contain files different from the current `HEAD`, including reviewed files.

**Recently Changed** is a flat list ordered by filesystem modification time. **Files** presents the same mode's files as a directory tree.

Review Loop does not parse or attribute pi tool calls. Any on-disk change—whether made by the agent, the user, or another process—updates the viewer. Deleted files use their parent directory's modification time as an ordering fallback.

## Diff controls

- `Cmd+F` on macOS, or `Ctrl+F` elsewhere: search within the focused diff pane
- Double-click a word: select it and highlight its other occurrences, including overview/minimap markers
- `Cmd+K` on macOS, or `Ctrl+K` elsewhere: focus the sidebar file filter
- Minimap and overview markers show changes, matches, and occurrences
- Scroll positions are remembered separately for each file and diff mode, including horizontal offsets
- A file opened for the first time starts at the top-left

Inline comments remain attached to the recorded pane and line number. If that file changes again before the review is submitted, verify that the comment still refers to the intended code.

## Session persistence

Each submitted review appends a `review-loop/checkpoint` custom entry to the active pi session. The checkpoint stores:

- the exact `HEAD` used by the checkpoint,
- compressed contents for files that differed from that `HEAD`,
- deleted-file state,
- reviewed paths,
- and the composed feedback.

When the session is resumed, `/diff-review` restores the latest checkpoint on the active session branch and compares it with the current workspace. Session branching therefore also branches review state.

Custom entries do not participate in model context. In an ephemeral `--no-session` run, checkpoint state lasts only for that process.

The review window closes when pi shuts down, switches sessions, or reloads extensions. Run `/diff-review` again after a reload or session switch.

## Requirements

- Node.js 20+
- pi
- A Git repository
- macOS, Linux, or Windows supported by [Glimpse](https://github.com/hazat/glimpse)

## Development

```sh
git clone https://github.com/earendil-works/pi-review-loop
cd pi-review-loop
npm install
npm run build
npm test
pi -e ./src/index.ts
```

When testing from a sibling repository, load the package directory directly:

```sh
cd ~/workspaces/some-project
pi -e ../pi-review-loop
```

After changing `web/src`, run `npm run build:web`; the extension serves the generated self-contained `web/dist/index.html`.
