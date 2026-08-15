# dsh-undo

[English](README.md) | 中文

> [!WARNING]
> **超前预览：本版本无法在任何当前已发布的 DeepSeek Harness 版本中使用。** 它依赖尚未发布的 Harness 持久化 `surface/rewind` / `surface/restore` 事件和 `conversation.chat.user-actions` WebUI slot。现在安装后，`/undo` 会安全拒绝并提示升级。本包当前仅用于预览和协调未来集成；在配套 Harness 正式发布前，不应视为可用于生产环境。请查看 <https://github.com/deepseek-ai/deepseek-harness/discussions/467/>

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的持久化多级撤销/重做插件。它按真实用户轮次回退模型上下文，并恢复该轮工具修改的工作树文件。

命令只在本地处理，绝不发送给模型：

- **`/undo`** 撤销当前可见的最后一条真实用户消息及其后的全部 surface 消息。
- **`/undo <user-seq>`** 从指定的可见用户消息开始撤销，同时移除其后的所有轮次。
- **`/redo`** 恢复最近一次仍有效的撤销。连续 undo/redo 按 LIFO 顺序执行。

WebUI Client 会在已完成的真实用户消息气泡上添加撤销按钮。按钮调用 `/undo <user-seq>`；Host 负责验证该消息当前是否仍是合法的回退目标。

## 工作原理

Harness 会话日志保持只追加。undo 为当前 surface 的精确连续后缀追加专用 `surface/rewind` 控制事件；redo 为最新 active rewind 追加 `surface/restore`。原消息节点、消息 ID、工具调用关联和日志事件均不改变。进程重启后，Session replay 会重建相同的可见 surface 与 redo 栈。

每次顶层工具执行前后，插件使用 `~/.dsh/dsh-undo/snapshots/` 下按会话隔离的隐藏 Git 目录记录工作树。它不会创建 commit、切换 branch，也不会修改仓库自己的 Git index。undo 只恢复所选用户轮次中工具实际触及的文件；redo 恢复 undo 前的工作树。patch 和 redo 元数据按会话保存，因此文件 redo 可跨 Host 重启继续使用。

工作树跟踪包含 tracked 文件和不超过 2 MiB 的未跟踪文件。仓库忽略的文件和更大的未跟踪文件保持不变。小型两阶段 journal 会在重启后依据持久化的 active-rewind 栈对账未完成的文件操作。若会话不在 Git 工作区内，上下文 undo/redo 仍然可用，命令会提示无法恢复文件。

顶层工具返回的后台任务会关联到对应用户轮次。undo 会请求停止被移除轮次启动的任务。redo 只恢复上下文和文件，不能重新启动已终止的进程。

## 要求

插件要求 Harness 提供：

- 持久化的 `surface/rewind` 和 `surface/restore` Session 事件。
- 用于 WebUI 消息按钮的 `conversation.chat.user-actions` Client slot。

旧版 Harness 会安全拒绝：`/undo` 会提示升级，而不会写入伪造的 assistant 替换消息或复制 transcript 事件。

## 限制

- 文件恢复只覆盖检测到的 Git 工作区，绝不会恢复该目录之外的文件。
- 网络请求、数据库写入、远程 API 调用、已退出进程及其他外部副作用无法撤销。
- 经嵌套工具派发或子 Agent 启动的后台任务可能无法关联到根用户轮次。
- undo 会向已记录的顶层后台任务发送停止请求，但不会无限等待进程退出。
- 新的普通 surface 输出会按 Harness surface 语义使当前 redo 历史失效。

## 安装

本包是 [dsh 组合包](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish/)。`package.json` 通过 `dsh.bundle` 指向 `cordis.patch.yml` 以启用 Host 插件，同时导出 WebUI Client bundle。

从 npm 安装：

```sh
dsh plugin --profile demo add dsh-undo
```

从 git 安装（`prepare` 脚本会在安装时构建 `lib/`；需先在 profile 的 `pnpm-workspace.yaml` 中授权构建）：

```sh
dsh plugin --profile demo add github:LingLambda/dsh-undo#<sha>
```

针对 Harness 源码检出做本地开发时，可通过 overlay 加载 Host 源码：

```sh
pnpm dsh web --patch ./cordis.patch.yml --patch /absolute/path/to/dsh-undo/overlay.yml
```

```yaml
- insert:
    - id: undo
      name: /absolute/path/to/dsh-undo/src/index.ts
```

## 用法

```text
/undo
/undo 42
/redo
```

使用 `/undo` 撤销最近用户轮次；点击较早用户消息上的按钮可从该处回退；使用 `/redo` 恢复最近一次撤销。

## 开发

```sh
corepack yarn install
corepack yarn typecheck
corepack yarn test
corepack yarn build
```

## License

MIT
