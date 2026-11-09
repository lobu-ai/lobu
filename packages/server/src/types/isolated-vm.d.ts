/**
 * Minimal type shim for `isolated-vm` so TypeScript compiles even when the
 * native module is missing locally (it's an optionalDependency — the native
 * build can fail on an unsupported platform). Production installs that can
 * load the native module get its own types; this shim is only consulted when
 * the package isn't on disk.
 *
 * Surface kept narrow on purpose — only the bits `src/sandbox/run-script.ts`
 * uses. If a future caller needs more, extend here.
 */

declare module "isolated-vm" {
  export interface IsolateOptions {
    memoryLimit?: number;
  }

  export interface ScriptRunOptions {
    timeout?: number;
    promise?: boolean;
    copy?: boolean;
  }

  export interface ReferenceApplyOptions {
    timeout?: number;
    result?: { promise?: boolean; copy?: boolean };
  }

  export class Isolate {
    constructor(options?: IsolateOptions);
    readonly isDisposed: boolean;
    createContext(): Promise<Context>;
    compileScript(source: string): Promise<Script>;
    dispose(): void;
  }

  export class Context {
    readonly global: Reference;
  }

  export class Script {
    run(context: Context, options?: ScriptRunOptions): Promise<unknown>;
  }

  export class Reference<T = unknown> {
    constructor(value: T);
    set(name: string, value: unknown): Promise<void>;
    derefInto(): unknown;
    apply(
      thisArg: unknown,
      args: unknown[],
      options?: ReferenceApplyOptions,
    ): Promise<unknown>;
    applySync(
      thisArg: unknown,
      args: unknown[],
      options?: ReferenceApplyOptions,
    ): unknown;
    applyIgnored(
      thisArg: unknown,
      args: unknown[],
      options?: ReferenceApplyOptions,
    ): void;
  }

  export class ExternalCopy<T = unknown> {
    constructor(value: T);
    copyInto(): T;
  }
}
