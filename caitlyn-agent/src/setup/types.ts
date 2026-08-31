/**
 * CAITLYN guided setup interaction types.
 */

/** One value presented by a single- or multi-selection prompt. */
export interface SetupChoice<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/** UI-independent prompt contract used by the setup workflow and tests. */
export interface SetupPrompts {
  heading(title: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  select<T extends string>(
    message: string,
    choices: SetupChoice<T>[],
    defaultValue?: T,
  ): Promise<T>;
  multiSelect<T extends string>(
    message: string,
    choices: SetupChoice<T>[],
    defaultValues?: T[],
  ): Promise<T[]>;
  input(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  close(): void;
}

/** Raised for Ctrl+C, EOF, or an explicit q selection. */
export class SetupCancelledError extends Error {
  constructor(message = "Setup cancelled") {
    super(message);
    this.name = "SetupCancelledError";
  }
}
