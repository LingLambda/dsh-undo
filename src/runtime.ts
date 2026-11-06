/** Per-agent durable surface undo/redo operations. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  activeRewindSeqs,
  appendSurfaceRestore,
  appendSurfaceRewind,
  computeUndoRange,
  lastVisibleText,
  supportsSurfaceRewind,
} from './domain.ts'
import { flushUndoPersistence } from './persistence.ts'
import type { WorkspaceUndoTracker } from './workspace.ts'

export const PERSISTENCE_UNCERTAIN_TEXT =
  '撤销/重做已应用到会话，但持久化尚未确认；请稍后检查会话记录。'
export const INTERNAL_ERROR_TEXT = '撤销/重做操作更新会话记录失败。'
export const CANCELLED_TEXT = '操作已取消。'
export const BUSY_TEXT = '当前会话正在处理其他操作；请在其完成后重试。'
export const UNSUPPORTED_TEXT =
  '当前 Harness 不支持安全的会话回退；请升级到包含 surface rewind/restore 的版本。'

/** One live root agent's undo/redo operations. */
export class UndoRuntime {
  constructor(
    private readonly rootCtx: Context,
    private readonly agent: Agent,
    private readonly workspace?: WorkspaceUndoTracker,
  ) {}

  async undo(signal: AbortSignal, targetUserSeq?: number): Promise<CommandResult> {
    if (signal.aborted) return { kind: 'error', text: CANCELLED_TEXT }
    try {
      return await this.agent.runMaintenance(maintenanceSignal =>
        this.undoIdle(signal, maintenanceSignal, targetUserSeq))
    } catch (error: unknown) {
      this.rootCtx.logger.warn(`undo: maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'error', text: BUSY_TEXT }
    }
  }

  private async undoIdle(
    signal: AbortSignal,
    maintenanceSignal: AbortSignal,
    targetUserSeq?: number,
  ): Promise<CommandResult> {
    if (signal.aborted || maintenanceSignal.aborted) return { kind: 'error', text: CANCELLED_TEXT }
    if (!supportsSurfaceRewind(this.agent.session)) return { kind: 'error', text: UNSUPPORTED_TEXT }
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
      await this.workspace?.reconcile()
    } catch {
      return { kind: 'error', text: PERSISTENCE_UNCERTAIN_TEXT }
    }
    const range = computeUndoRange(this.agent.session, targetUserSeq)
    if (range === undefined) {
      return {
        kind: 'success',
        text: targetUserSeq === undefined
          ? '没有可撤销的用户输入。'
          : `无法撤销用户消息 ${targetUserSeq}：它不在当前模型上下文中。`,
      }
    }
    if (signal.aborted || maintenanceSignal.aborted) return { kind: 'error', text: CANCELLED_TEXT }
    let workspaceResult: Awaited<ReturnType<WorkspaceUndoTracker['undo']>> | undefined
    let killedJobs = 0
    const rewindSeq = this.agent.session.seq
    try {
      const userSeqs = range.shadowedSeqs.filter((seq) => {
        const session = this.agent.session as any
        const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : session.events?.[seq]
        return event?.type === 'user/message' && event.data.source.kind === 'user'
      })
      workspaceResult = await this.workspace?.undo(userSeqs, rewindSeq)
      appendSurfaceRewind(this.agent.session, range)
      killedJobs = this.workspace?.killJobs(userSeqs) ?? 0
    } catch (error: unknown) {
      try {
        await this.workspace?.rollbackUndo(rewindSeq)
      } catch (rollbackError: unknown) {
        this.rootCtx.logger.warn(`undo: workspace compensation failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      this.rootCtx.logger.warn(`undo: surface rewind failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'error', text: INTERNAL_ERROR_TEXT }
    }
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
      await this.workspace?.commitUndo(rewindSeq)
    } catch {
      return { kind: 'error', text: PERSISTENCE_UNCERTAIN_TEXT }
    }
    const target = lastVisibleText(this.agent.session)
    const workspaceText = workspaceResult?.files === undefined || workspaceResult.files === 0
      ? ''
      : `，并恢复 ${workspaceResult.files} 个工作树文件`
    const jobsText = killedJobs === 0 ? '' : `，并停止 ${killedJobs} 个后台任务`
    const warning = workspaceResult?.warning === undefined ? '' : ` ${workspaceResult.warning}`
    return {
      kind: 'success',
      text: target === undefined
        ? `已撤销从用户消息 ${range.userSeq} 开始的 ${range.shadowedSeqs.length} 条上下文消息${workspaceText}${jobsText}；输入 /redo 可恢复。${warning}`
        : `已回退至 "${target}"${workspaceText}${jobsText}；输入 /redo 可恢复。${warning}`,
    }
  }

  async redo(signal: AbortSignal): Promise<CommandResult> {
    if (signal.aborted) return { kind: 'error', text: CANCELLED_TEXT }
    try {
      return await this.agent.runMaintenance(maintenanceSignal => this.redoIdle(signal, maintenanceSignal))
    } catch (error: unknown) {
      this.rootCtx.logger.warn(`redo: maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'error', text: BUSY_TEXT }
    }
  }

  private async redoIdle(signal: AbortSignal, maintenanceSignal: AbortSignal): Promise<CommandResult> {
    if (signal.aborted || maintenanceSignal.aborted) return { kind: 'error', text: CANCELLED_TEXT }
    if (!supportsSurfaceRewind(this.agent.session)) return { kind: 'error', text: UNSUPPORTED_TEXT }
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
      await this.workspace?.reconcile()
    } catch {
      return { kind: 'error', text: PERSISTENCE_UNCERTAIN_TEXT }
    }
    const rewindSeq = activeRewindSeqs(this.agent.session).at(-1)
    if (rewindSeq === undefined) return { kind: 'success', text: '没有可重做的内容：已是最新状态。' }
    if (signal.aborted || maintenanceSignal.aborted) return { kind: 'error', text: CANCELLED_TEXT }
    let workspaceResult: Awaited<ReturnType<WorkspaceUndoTracker['redo']>> | undefined
    try {
      workspaceResult = await this.workspace?.redo(rewindSeq)
      appendSurfaceRestore(this.agent.session, rewindSeq)
    } catch (error: unknown) {
      try {
        await this.workspace?.rollbackRedo(rewindSeq)
      } catch (rollbackError: unknown) {
        this.rootCtx.logger.warn(`redo: workspace compensation failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      this.rootCtx.logger.warn(`redo: surface restore failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'error', text: INTERNAL_ERROR_TEXT }
    }
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
      await this.workspace?.commitRedo(rewindSeq)
    } catch {
      return { kind: 'error', text: PERSISTENCE_UNCERTAIN_TEXT }
    }
    const workspaceText = workspaceResult?.files === undefined || workspaceResult.files === 0
      ? ''
      : `，并恢复 ${workspaceResult.files} 个工作树文件`
    return { kind: 'success', text: `已恢复最近撤销的模型上下文${workspaceText}；输入 /undo 可再次回滚。` }
  }
}
