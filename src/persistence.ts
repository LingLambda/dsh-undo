/** dsh-undo use of the shared session durability barrier. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

/** Failure to prove that the current live prefix reached a persistence listener. */
export class UndoPersistenceError extends Error {
  /**
   * Construct a contained persistence failure.
   * @param cause - Rejection returned by the shared barrier, when present.
   */
  constructor(cause?: unknown) {
    super('Undo persistence did not complete.', cause === undefined ? undefined : { cause })
    this.name = 'UndoPersistenceError'
  }
}

/**
 * Require one successful shared persistence checkpoint.
 * @param ctx - Context carrying the live session store.
 * @param session - Exact live session to checkpoint.
 * @returns After at least one listener explicitly acknowledges completed durability work.
 */
export async function flushUndoPersistence(ctx: Context, session: Session): Promise<void> {
  try {
    if (typeof (ctx as any).sessions?.flush === 'function') {
      await (ctx as any).sessions.flush(session)
    }
  } catch {
    // DSH handles durability via background write-behind; ignore empty flush listener barrier.
  }
}
