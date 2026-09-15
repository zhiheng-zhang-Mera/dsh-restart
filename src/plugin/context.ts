/**
 * The narrow slice of the harness context this plugin uses.
 *
 * Same approach as the rest of the fleet: the plugin declares the handful of
 * services it touches instead of depending on the harness's full `Context` type, so
 * it compiles and runs against any harness release that provides them, and a
 * missing service is a runtime fact the plugin reports rather than a type error.
 *
 * @module dsh-restart/plugin/context
 */

/** Minimal logger surface. */
export interface PluginLogger {
  debug?(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

/** One registered settings namespace handle. */
export interface SettingsScopeLike<T> {
  get(): T
  watch?(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** Minimal settings service surface. */
export interface SettingsServiceLike {
  register<T>(ns: string, schema: unknown, options?: { base?: T; applies?: 'live' | 'restart' }): SettingsScopeLike<T>
}

/** A tool definition, structurally compatible with the harness's own type. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: unknown, value: unknown) => readonly unknown[]
  }
  readonly execute: (args: never, exec?: { signal?: AbortSignal }) => Promise<unknown>
  readonly timeoutMs?: number
}

/** Minimal tool runtime surface. */
export interface ToolRuntimeLike {
  register(definition: ToolDefinitionLike): () => void
}

/** Everything the plugin reads off `ctx`. */
export interface HarnessContextLike {
  readonly logger?: PluginLogger
  readonly tools?: ToolRuntimeLike
  readonly settings?: SettingsServiceLike
  /**
   * Root directory for durable plugin state, when the host provides one. The
   * plugin prefers `$DSH_HOME` and falls back to this.
   */
  readonly stateDirectory?: string
  effect?(callback: () => void | (() => void)): void
}

/** A no-op logger. */
export const SILENT_LOGGER: PluginLogger = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
})

/** Extract a usable logger from the context. */
export function loggerOf(ctx: HarnessContextLike): PluginLogger {
  return ctx.logger ?? SILENT_LOGGER
}
