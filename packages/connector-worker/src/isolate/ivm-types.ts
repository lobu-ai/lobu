/**
 * Structural view of the `isolated-vm` surface the bridge uses.
 *
 * Kept separate from the module's own typings so no public worker type
 * depends on `isolated-vm` being installed: `loadIsolatedVm()` narrows the
 * dynamically imported module to this shape at the load boundary.
 */

export interface IvmReferenceApplyOptions {
  timeout?: number;
  arguments?: { copy?: boolean };
  result?: { promise?: boolean; copy?: boolean };
}

export interface IvmReference {
  set(name: string, value: unknown): Promise<void>;
  derefInto(): unknown;
  apply(thisArg: unknown, args: unknown[], options?: IvmReferenceApplyOptions): Promise<unknown>;
  applySync(thisArg: unknown, args: unknown[], options?: IvmReferenceApplyOptions): unknown;
}

export interface IvmContext {
  readonly global: IvmReference;
}

export interface IvmScriptRunOptions {
  timeout?: number;
  promise?: boolean;
  copy?: boolean;
}

export interface IvmScript {
  run(context: IvmContext, options?: IvmScriptRunOptions): Promise<unknown>;
}

export interface IvmIsolate {
  readonly isDisposed: boolean;
  createContext(): Promise<IvmContext>;
  compileScript(source: string, options?: { filename?: string }): Promise<IvmScript>;
  dispose(): void;
}

/** The loaded `isolated-vm` module, narrowed to what the bridge constructs. */
export interface IsolatedVm {
  Isolate: new (options?: { memoryLimit?: number }) => IvmIsolate;
  Reference: new (value: unknown) => IvmReference;
}
