/**
 * Atomic, self-validating file I/O.
 *
 * The restart path writes files that another process will act on: a stale or
 * half-written ticket must never be mistaken for a live one. So every write here
 * is temp-file + fsync + rename, every document carries a schema version, and the
 * ticket carries a checksum over its own canonical form.
 *
 * @module dsh-restart/atomic
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Write a UTF-8 file atomically.
 *
 * The sequence matters: write to a sibling temp file, `fsync` it so the bytes are
 * durable, then `rename` it over the target. A crash therefore leaves either the
 * old file or the new one, never a mixture.
 *
 * @param path - destination path.
 * @param contents - full file contents.
 * @param options - `fsync` defaults to `true`.
 * @returns the number of bytes written.
 */
export function writeFileAtomic(
  path: string,
  contents: string,
  options: { readonly fsync?: boolean; readonly mode?: number } = {},
): number {
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const bytes = Buffer.from(contents, 'utf8')
  const fsync = options.fsync !== false
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'w', options.mode ?? 0o600)
    writeSync(descriptor, bytes)
    if (fsync) fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporary, path)
    return bytes.byteLength
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // The descriptor is already gone; nothing to recover.
      }
    }
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Best effort: the temp file may not exist.
    }
    throw error
  }
}

/** Write a JSON document atomically, with a trailing newline. */
export function writeJsonAtomic(path: string, value: unknown): number {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Read and parse a JSON file.
 *
 * @returns the parsed value, or `null` when the file is missing, unreadable or
 *   not valid JSON. A caller that must distinguish those cases checks
 *   {@link existsSync} first; the restart path treats all three as "no ticket",
 *   which is the safe reading.
 */
export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Modification time in epoch milliseconds, or `null` when unreadable. */
export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Size in bytes, or `null` when unreadable. */
export function sizeBytes(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** `sha256:<hex>` digest of a UTF-8 string. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}
