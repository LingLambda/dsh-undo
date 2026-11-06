/** Hidden-Git workspace checkpoints associated with user turns. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
const STATE_VERSION = 2

interface WorkspacePatch {
  readonly callSeq: number
  readonly before: string
  readonly files: readonly string[]
}

interface WorkspaceRedo {
  readonly tree: string
  readonly files: readonly string[]
}

interface PersistedState {
  readonly version: number
  readonly patches: [number, WorkspacePatch[]][]
  readonly redos: [number, WorkspaceRedo][]
  readonly pending?: PendingWorkspaceOperation
}

interface WorkspaceTarget {
  readonly file: string
  readonly tree: string
}

interface PendingWorkspaceOperation {
  readonly kind: 'undo' | 'redo'
  readonly rewindSeq: number
  readonly rollback: WorkspaceRedo
  readonly target: readonly WorkspaceTarget[]
}

interface BackgroundResult {
  readonly kind?: unknown
  readonly jobId?: unknown
}

interface JobRegistry {
  kill(id: string, caller?: Agent, reason?: string): 'requested' | 'already-finished'
}

export interface WorkspaceOperationResult {
  readonly files: number
  readonly warning?: string
}

/** Workspace checkpoint recorder for one agent. */
export class WorkspaceUndoTracker {
  private root: string | undefined
  private gitDir: string | undefined
  private unavailable: string | undefined
  private initPromise: Promise<boolean> | undefined
  private gitTail: Promise<void> = Promise.resolve()
  private stateTail: Promise<void> = Promise.resolve()
  private readonly patches = new Map<number, WorkspacePatch[]>()
  private readonly redos = new Map<number, WorkspaceRedo>()
  private pending: PendingWorkspaceOperation | undefined
  private readonly jobs = new Map<number, string[]>()

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {}

  /** Wrap one top-level tool call with before/after workspace trees. */
  async around(
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    if (exec.parent !== undefined) return next()
    const userSeq = this.userSeqForCall(String(exec.rootCallId))
    const before = userSeq === undefined ? undefined : await this.snapshot()
    let result: ToolExecutionResult | undefined
    try {
      result = await next()
      return result
    } finally {
      if (userSeq !== undefined && result !== undefined && !result.isError) {
        const value = result.value as BackgroundResult | null
        if (value?.kind === 'background' && typeof value.jobId === 'string') {
          const list = this.jobs.get(userSeq) ?? []
          if (!list.includes(value.jobId)) list.push(value.jobId)
          this.jobs.set(userSeq, list)
        }
      }
      if (userSeq !== undefined && before !== undefined) {
        try {
          const after = await this.snapshot()
          if (after !== undefined && after !== before) {
            const files = await this.changedFiles(before, after)
            if (files.length > 0) {
              const callSeq = this.callSeq(String(exec.rootCallId)) ?? Number.MAX_SAFE_INTEGER
              const list = this.patches.get(userSeq) ?? []
              list.push({ callSeq, before, files })
              this.patches.set(userSeq, list)
              await this.persistState()
            }
          }
        } catch (error: unknown) {
          this.ctx.logger.warn(`undo: workspace checkpoint failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /** Restore files changed by tools associated with the selected user turns. */
  async undo(userSeqs: readonly number[], rewindSeq: number): Promise<WorkspaceOperationResult> {
    if (!await this.initialize()) return { files: 0, warning: this.unavailable }
    const patches = userSeqs
      .flatMap(userSeq => this.patches.get(userSeq) ?? [])
      .sort((a, b) => a.callSeq - b.callSeq)
    if (patches.length === 0) return { files: 0 }
    const current = await this.snapshot()
    if (current === undefined) return { files: 0, warning: this.unavailable ?? 'workspace snapshot unavailable' }
    const firstByFile = new Map<string, string>()
    for (const patch of patches) {
      for (const file of patch.files) {
        if (!firstByFile.has(file) && !await this.isExcludedCurrentFile(file)) firstByFile.set(file, patch.before)
      }
    }
    const files = [...firstByFile.keys()]
    const rollback = { tree: current, files }
    this.pending = {
      kind: 'undo',
      rewindSeq,
      rollback,
      target: [...firstByFile].map(([file, tree]) => ({ file, tree })),
    }
    await this.persistState()
    try {
      await this.restoreTargets(this.pending.target)
      this.redos.set(rewindSeq, rollback)
      await this.persistState()
    } catch (error: unknown) {
      try { await this.restoreRedo(rollback) } catch {}
      this.redos.delete(rewindSeq)
      this.pending = undefined
      try { await this.persistState() } catch {}
      throw error
    }
    return { files: files.length }
  }

  /** Restore the workspace state captured immediately before an undo. */
  async redo(rewindSeq: number): Promise<WorkspaceOperationResult> {
    if (!await this.initialize()) return { files: 0, warning: this.unavailable }
    const redo = this.redos.get(rewindSeq)
    if (redo === undefined) return { files: 0 }
    const current = await this.snapshot()
    if (current === undefined) return { files: 0, warning: this.unavailable ?? 'workspace snapshot unavailable' }
    this.pending = {
      kind: 'redo',
      rewindSeq,
      rollback: { tree: current, files: redo.files },
      target: redo.files.map(file => ({ file, tree: redo.tree })),
    }
    await this.persistState()
    try {
      await this.restoreTargets(this.pending.target)
    } catch (error: unknown) {
      try { await this.restoreRedo(this.pending.rollback) } catch {}
      this.pending = undefined
      try { await this.persistState() } catch {}
      throw error
    }
    return { files: redo.files.length }
  }

  /** Restore the pre-redo workspace if the matching surface restore failed. */
  async rollbackRedo(rewindSeq: number): Promise<void> {
    if (this.pending?.kind !== 'redo' || this.pending.rewindSeq !== rewindSeq) return
    await this.restoreRedo(this.pending.rollback)
    this.pending = undefined
    await this.persistState()
  }

  /** Restore the pre-undo workspace if the matching surface rewind failed. */
  async rollbackUndo(rewindSeq: number): Promise<void> {
    if (this.pending?.kind !== 'undo' || this.pending.rewindSeq !== rewindSeq) return
    await this.restoreRedo(this.pending.rollback)
    this.redos.delete(rewindSeq)
    this.pending = undefined
    await this.persistState()
  }

  /** Clear a committed undo journal after the session durability barrier. */
  async commitUndo(rewindSeq: number): Promise<void> {
    if (this.pending?.kind !== 'undo' || this.pending.rewindSeq !== rewindSeq) return
    const pending = this.pending
    this.pending = undefined
    try {
      await this.persistState()
    } catch (error: unknown) {
      this.pending = pending
      throw error
    }
  }

  /** Forget the redo entry after the surface restore commits. */
  async commitRedo(rewindSeq: number): Promise<void> {
    const redo = this.redos.get(rewindSeq)
    const pending = this.pending?.kind === 'redo' && this.pending.rewindSeq === rewindSeq
      ? this.pending
      : undefined
    this.redos.delete(rewindSeq)
    if (pending !== undefined) this.pending = undefined
    try {
      await this.persistState()
    } catch (error: unknown) {
      if (redo !== undefined) this.redos.set(rewindSeq, redo)
      if (pending !== undefined) this.pending = pending
      throw error
    }
  }

  /** Reconcile a crash journal after the live session prefix has been flushed. */
  async reconcile(): Promise<void> {
    if (!await this.initialize() || this.pending === undefined) return
    const pending = this.pending
    const active = 'activeRewinds' in this.agent.session.surface
      && (this.agent.session.surface as unknown as { activeRewinds: readonly number[] }).activeRewinds.includes(pending.rewindSeq)
    const current = await this.snapshot()
    if (current === undefined) return
    if (await this.matchesEitherJournalState(current, pending)) {
      if (pending.kind === 'undo') {
        if (active) await this.restoreTargets(pending.target)
        else await this.restoreRedo(pending.rollback)
      } else if (active) {
        await this.restoreRedo(pending.rollback)
      } else {
        await this.restoreTargets(pending.target)
      }
    } else {
      this.ctx.logger.warn('undo: workspace changed after an interrupted operation; preserving current files and clearing the recovery journal')
    }
    if (pending.kind === 'undo' && active) this.redos.set(pending.rewindSeq, pending.rollback)
    if (!active) this.redos.delete(pending.rewindSeq)
    this.pending = undefined
    await this.persistState()
  }

  /** Stop background jobs started by tools in the selected user turns. */
  killJobs(userSeqs: readonly number[]): number {
    const registry = this.ctx.get('jobs') as JobRegistry | undefined
    if (registry === undefined) return 0
    let killed = 0
    for (const userSeq of userSeqs) {
      const failed: string[] = []
      for (const jobId of this.jobs.get(userSeq) ?? []) {
        try {
          if (registry.kill(jobId, this.agent, 'undo') === 'requested') killed++
        } catch (error: unknown) {
          failed.push(jobId)
          this.ctx.logger.warn(`undo: failed to stop background job ${jobId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failed.length === 0) this.jobs.delete(userSeq)
      else this.jobs.set(userSeq, failed)
    }
    return killed
  }

  private getSessionEvents(): readonly SessionEvent[] {
    const session = this.agent.session as any
    if (typeof session.snapshotEvents === 'function') {
      return session.snapshotEvents()
    }
    return session.events ?? []
  }

  private userSeqForCall(callId: string): number | undefined {
    const events = this.getSessionEvents()
    const callIndex = events.findIndex(event => event.type === 'tool/call' && String(event.data.callId) === callId)
    if (callIndex < 0) return undefined
    for (let index = callIndex - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type === 'turn/start') break
      if (event?.type === 'user/message' && event.data.source.kind === 'user') return event.seq
    }
    return undefined
  }

  private callSeq(callId: string): number | undefined {
    return this.getSessionEvents().find(event =>
      event.type === 'tool/call' && String(event.data.callId) === callId)?.seq
  }

  private async initialize(): Promise<boolean> {
    this.initPromise ??= this.initializeOnce()
    return this.initPromise
  }

  private async initializeOnce(): Promise<boolean> {
    const cwd = this.agent.session.header.cwd
    if (cwd === undefined) {
      this.unavailable = '会话没有工作目录；仅撤销模型上下文。'
      return false
    }
    try {
      const root = (await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).stdout.trim()
      if (root === '') throw new Error('empty repository root')
      this.root = resolve(root)
      const key = createHash('sha256')
        .update(this.root)
        .update('\0')
        .update(String(this.agent.session.header.id))
        .digest('hex')
        .slice(0, 24)
      this.gitDir = join(homedir(), '.dsh', 'dsh-undo', 'snapshots', key)
      await mkdir(this.gitDir, { recursive: true })
      try {
        await this.git(['rev-parse', '--is-bare-repository'])
      } catch {
        await execFileAsync('git', ['init', '--bare', this.gitDir], { encoding: 'utf8' })
        await this.git(['config', 'core.autocrlf', 'false'])
        await this.git(['config', 'core.longpaths', 'true'])
      }
      await this.loadState()
      return true
    } catch (error: unknown) {
      this.unavailable = `工作树快照不可用；仅撤销模型上下文：${error instanceof Error ? error.message : String(error)}`
      return false
    }
  }

  private async snapshot(): Promise<string | undefined> {
    if (!await this.initialize()) return undefined
    return this.serialGit(async () => {
      const tracked = this.splitPaths(await this.sourceGit(['ls-files', '-z', '--cached', '--', '.']))
      const untracked = this.splitPaths(await this.sourceGit(['ls-files', '-z', '--others', '--exclude-standard', '--', '.']))
      const allowedUntracked: string[] = []
      for (const file of untracked) {
        try {
          const info = await stat(join(this.requireRoot(), file))
          if (!info.isFile() || info.size <= MAX_UNTRACKED_BYTES) allowedUntracked.push(file)
        } catch {}
      }
      const candidates = [...new Set([...tracked, ...allowedUntracked])]
      for (const batch of this.pathBatches(candidates)) {
        await this.git(['add', '--all', '--', ...batch.map(file => `:(top,literal)${file}`)])
      }
      const candidateSet = new Set(candidates)
      const hiddenFiles = this.splitPaths(await this.git(['ls-files', '-z']))
      const deleted = hiddenFiles.filter(file => !candidateSet.has(file))
      for (const batch of this.pathBatches(deleted)) {
        await this.git(['rm', '--cached', '-f', '--ignore-unmatch', '--', ...batch.map(file => `:(top,literal)${file}`)])
      }
      return (await this.git(['write-tree'])).trim()
    })
  }

  private async changedFiles(before: string, after: string): Promise<string[]> {
    const output = await this.serialGit(() => this.git(['diff', '--name-only', '-z', before, after, '--', '.']))
    const files = output.split('\0').filter(Boolean)
    const filtered: string[] = []
    for (const file of files) {
      if (!await this.isExcludedCurrentFile(file)) filtered.push(file)
    }
    return filtered
  }

  private async isExcludedCurrentFile(file: string): Promise<boolean> {
    const root = this.requireRoot()
    try {
      await execFileAsync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', file], { encoding: 'utf8' })
      return true
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 1) throw error
    }
    try {
      await execFileAsync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', file], { encoding: 'utf8' })
      return false
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 1) throw error
    }
    try {
      const info = await stat(join(root, file))
      return info.isFile() && info.size > MAX_UNTRACKED_BYTES
    } catch {
      return false
    }
  }

  private async restoreFile(tree: string, file: string): Promise<void> {
    const path = this.workspacePath(file)
    const literal = `:(top,literal)${file}`
    const listed = await this.serialGit(() => this.git(['ls-tree', '-r', '--name-only', '-z', tree, '--', literal]))
    if (!listed.split('\0').includes(file)) {
      await rm(path, { recursive: true, force: true })
      return
    }
    await this.serialGit(() => this.git(['checkout', tree, '--', literal]))
  }

  private async restoreTargets(targets: readonly WorkspaceTarget[]): Promise<void> {
    for (const target of targets) await this.restoreFile(target.tree, target.file)
  }

  private async restoreRedo(redo: WorkspaceRedo): Promise<void> {
    for (const file of redo.files) await this.restoreFile(redo.tree, file)
  }

  private async matchesEitherJournalState(current: string, pending: PendingWorkspaceOperation): Promise<boolean> {
    const targetByFile = new Map(pending.target.map(target => [target.file, target.tree]))
    for (const file of pending.rollback.files) {
      const currentEntry = await this.treeEntry(current, file)
      const rollbackEntry = await this.treeEntry(pending.rollback.tree, file)
      const targetEntry = await this.treeEntry(targetByFile.get(file) ?? pending.rollback.tree, file)
      if (currentEntry !== rollbackEntry && currentEntry !== targetEntry) return false
    }
    return true
  }

  private treeEntry(tree: string, file: string): Promise<string> {
    return this.serialGit(() => this.git(['ls-tree', '-r', '-z', tree, '--', `:(top,literal)${file}`]))
  }

  private async git(args: string[]): Promise<string> {
    const root = this.requireRoot()
    if (this.gitDir === undefined) throw new Error('snapshot git directory is unavailable')
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.autocrlf=false',
      '-c', 'core.longpaths=true',
      '--git-dir', this.gitDir,
      '--work-tree', root,
      ...args,
    ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return stdout
  }

  private async sourceGit(args: string[]): Promise<string> {
    const root = this.requireRoot()
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  }

  private splitPaths(output: string): string[] {
    return output.split('\0').filter(Boolean)
  }

  private pathBatches(paths: readonly string[]): string[][] {
    const batches: string[][] = []
    let batch: string[] = []
    let length = 0
    for (const path of paths) {
      if (batch.length > 0 && length + path.length > 24_000) {
        batches.push(batch)
        batch = []
        length = 0
      }
      batch.push(path)
      length += path.length + 16
    }
    if (batch.length > 0) batches.push(batch)
    return batches
  }

  private async loadState(): Promise<void> {
    if (this.gitDir === undefined) return
    try {
      const parsed = JSON.parse(await readFile(join(this.gitDir, 'dsh-undo-state.json'), 'utf8')) as Partial<PersistedState>
      if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.patches) || !Array.isArray(parsed.redos)) return
      for (const [userSeq, patches] of parsed.patches) {
        if (Number.isSafeInteger(userSeq) && Array.isArray(patches)) this.patches.set(userSeq, patches)
      }
      for (const [rewindSeq, redo] of parsed.redos) {
        if (Number.isSafeInteger(rewindSeq) && redo !== undefined) this.redos.set(rewindSeq, redo)
      }
      if (parsed.pending?.kind === 'undo' || parsed.pending?.kind === 'redo') this.pending = parsed.pending
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger.warn(`undo: failed to load workspace history: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private persistState(): Promise<void> {
    if (this.gitDir === undefined) return Promise.resolve()
    const state: PersistedState = {
      version: STATE_VERSION,
      patches: [...this.patches.entries()],
      redos: [...this.redos.entries()],
      ...(this.pending === undefined ? {} : { pending: this.pending }),
    }
    const path = join(this.gitDir, 'dsh-undo-state.json')
    const temporary = `${path}.${process.pid}.tmp`
    const operation = async () => {
      await writeFile(temporary, JSON.stringify(state), 'utf8')
      await rename(temporary, path)
    }
    const result = this.stateTail.then(operation, operation)
    this.stateTail = result.then(() => undefined, () => undefined)
    return result
  }

  private requireRoot(): string {
    if (this.root === undefined) throw new Error('workspace root is unavailable')
    return this.root
  }

  private workspacePath(file: string): string {
    const root = this.requireRoot()
    const path = resolve(root, file)
    const rel = relative(root, path)
    if (file === '' || rel === '' || isAbsolute(file) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`unsafe workspace path: ${file}`)
    }
    return path
  }

  private serialGit<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gitTail.then(operation, operation)
    this.gitTail = result.then(() => undefined, () => undefined)
    return result
  }
}
