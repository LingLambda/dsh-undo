# dsh-undo

English | [中文](README.zh.md)

> [!WARNING]
> **Forward-looking preview: this release is not usable with any currently published DeepSeek Harness version.** It depends on unreleased Harness support for durable `surface/rewind` / `surface/restore` events and the `conversation.chat.user-actions` WebUI slot. Installing it today will make `/undo` fail closed with an upgrade message. Publish this package only to preview and coordinate the future integration; do not present it as production-ready until the matching Harness release exists. look for <https://github.com/deepseek-ai/deepseek-harness/discussions/467/>

Durable, multi-level undo/redo for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It rewinds model context by real user turn and restores workspace files changed by tools in that turn.

The commands are handled locally and are never sent to the model:

- **`/undo`** rewinds the latest visible real user message and every surface message after it.
- **`/undo <user-seq>`** rewinds from a specific visible user message, including all later turns.
- **`/redo`** restores the latest active rewind. Repeated undo and redo operations use LIFO order.

The WebUI client contributes an undo action to finalized real-user message bubbles. The action invokes `/undo <user-seq>`; the Host validates that the addressed message is still a legal rewind target.

## How It Works

Harness sessions remain append-only. Undo appends a dedicated `surface/rewind` control event for the exact current surface suffix; redo appends `surface/restore` for the newest active rewind. The original message nodes, message IDs, tool-call correlations, and log events are retained. Session replay reconstructs the same visible surface and redo stack after restart.

Before and after each top-level tool execution, the plugin records a workspace tree using an isolated hidden Git directory under `~/.dsh/dsh-undo/snapshots/`. It does not create commits, switch branches, or modify the repository's own Git index. Undo restores only files touched by tools in the selected user turns; redo restores the pre-undo tree. Patch and redo metadata are stored per session so file redo can survive a Host restart.

Workspace tracking includes tracked files and untracked files up to 2 MiB. Files ignored by the repository and larger untracked files are left untouched. A small two-phase journal reconciles interrupted file operations against the durable active-rewind stack after restart. If the session has no Git workspace, context undo/redo still works and the command reports that file restoration is unavailable.

Background jobs returned by top-level tools are associated with their user turn. Undo requests termination for jobs started in the removed turns. Redo restores context and files but cannot restart terminated processes.

## Requirements

This plugin requires a Harness version that supports:

- Durable `surface/rewind` and `surface/restore` session events.
- The `conversation.chat.user-actions` client slot for the WebUI action.

Older Harness releases fail closed: `/undo` reports that a compatible Harness upgrade is required instead of writing replacement assistant messages or copying transcript events.

## Limits

- File restoration is limited to the detected Git workspace. It never restores files outside that root.
- Network requests, database writes, remote API calls, already-exited processes, and other external effects cannot be undone.
- Background jobs started through nested tool dispatches or child agents may not be associated with the root user turn.
- Undo signals recorded top-level background jobs but does not wait indefinitely for process exit.
- New ordinary surface output invalidates active redo history according to Harness surface semantics.

## Install

The package is a [dsh bundle](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish/). `package.json` points `dsh.bundle` to `cordis.patch.yml`, which activates the Host plugin, and exposes a WebUI Client bundle.

From npm:

```sh
dsh plugin --profile demo add dsh-undo
```

From git (the `prepare` script builds `lib/` during installation; authorize the build in the profile's `pnpm-workspace.yaml` first):

```sh
dsh plugin --profile demo add github:LingLambda/dsh-undo#<sha>
```

For local development against a Harness checkout, load the Host source with an overlay:

```sh
pnpm dsh web --patch ./cordis.patch.yml --patch /absolute/path/to/dsh-undo/overlay.yml
```

```yaml
- insert:
    - id: undo
      name: /absolute/path/to/dsh-undo/src/index.ts
```

## Usage

```text
/undo
/undo 42
/redo
```

Use `/undo` for the latest user turn, the action on an older user bubble to rewind from that point, and `/redo` to restore the most recent rewind.

## Develop

```sh
corepack yarn install
corepack yarn typecheck
corepack yarn test
corepack yarn build
```

## License

MIT
