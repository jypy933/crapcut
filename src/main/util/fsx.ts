// File helpers.

import { copyFileSync, renameSync, rmSync } from 'node:fs'

/** Moves a file, falling back to copy + delete across drives. */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}
