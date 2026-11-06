/** Pure undo/redo selection and Session surface-control operations. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'surface/rewind': { start: number; end: number; shadowedSeqs: number[] }
    'surface/restore': { rewindSeq: number }
  }
}

/** The current surface suffix removed by one undo. */
export interface UndoRange {
  readonly userSeq: number
  readonly shadowedSeqs: readonly number[]
}

/** A surface node that derives to a visible message. */
export interface LastVisibleMessage {
  readonly seq: number
  readonly type: 'user/message' | 'assistant/message' | 'tool/result'
  readonly turn: number | undefined
}

/** New Harness surface-control capability required by this plugin. */
interface RewindSurface {
  readonly nodes: readonly number[]
  readonly activeRewinds: readonly number[]
}

/** Whether this Harness implements durable surface rewind/restore. */
export function supportsSurfaceRewind(session: Session): boolean {
  return 'activeRewinds' in session.surface
}

/** Read the durable active rewind stack, newest last. */
export function activeRewindSeqs(session: Session): readonly number[] {
  if (!supportsSurfaceRewind(session)) return []
  return (session.surface as unknown as RewindSurface).activeRewinds
}

function getSessionEvent(session: Session, seq: number): SessionEvent | undefined {
  if (typeof (session as any).eventAt === 'function') {
    return (session as any).eventAt(seq)
  }
  return (session as any).events?.[seq]
}

/** Locate the newest visible model message. */
export function lastVisibleMessage(session: Session): LastVisibleMessage | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index--) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = getSessionEvent(session, seq)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (session.deriveEventMessage(event) === null) continue
    return {
      seq,
      type: event.type,
      turn: event.type === 'user/message' ? undefined : event.data.turn,
    }
  }
  return undefined
}

/**
 * Select a real user message and every current surface node after it. With no
 * target, the latest visible human input is selected. A target allows the UI
 * action on an older user bubble to rewind that message and all later turns.
 */
export function computeUndoRange(session: Session, targetUserSeq?: number): UndoRange | undefined {
  const nodes = session.surface.nodes
  let userIndex = -1
  for (let index = nodes.length - 1; index >= 0; index--) {
    const seq = nodes[index]
    if (seq === undefined) continue
    if (targetUserSeq !== undefined && seq !== targetUserSeq) continue
    const event = getSessionEvent(session, seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    userIndex = index
    break
  }
  if (userIndex < 0) return undefined
  const userSeq = nodes[userIndex]
  if (userSeq === undefined) return undefined
  return { userSeq, shadowedSeqs: nodes.slice(userIndex) }
}

/** Append a durable suffix rewind and return its control event. */
export function appendSurfaceRewind(
  session: Session,
  range: UndoRange,
): SessionEvent<'surface/rewind'> {
  const end = range.shadowedSeqs.at(-1)
  if (end === undefined) throw new Error('surface rewind requires a non-empty range')
  return session.append('surface/rewind', {
    start: range.userSeq,
    end,
    shadowedSeqs: [...range.shadowedSeqs],
  })
}

/** Restore the newest durable rewind without copying its messages. */
export function appendSurfaceRestore(
  session: Session,
  rewindSeq: number,
): SessionEvent<'surface/restore'> {
  return session.append('surface/restore', { rewindSeq })
}

/** A short text preview of the latest visible real user input. */
export function lastVisibleText(session: Session, max = 30): string | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index--) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = getSessionEvent(session, seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && 'text' in block)
      .map(block => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '') continue
    return text.length <= max ? text : text.slice(0, max) + '…'
  }
  return undefined
}
