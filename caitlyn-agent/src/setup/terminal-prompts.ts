/**
 * CAITLYN line-oriented terminal prompts.
 *
 * The implementation deliberately uses only Node.js primitives so the npm
 * package does not need a second interactive UI dependency.
 */

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { SetupChoice, SetupPrompts } from "./types.js";
import { SetupCancelledError } from "./types.js";

/** Writable proxy that can suppress readline redraws while a secret is read. */
class MuteableOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  /** Forward normal prompt output and discard secret-input redraws. */
  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      if (typeof chunk === "string") this.target.write(chunk, encoding);
      else this.target.write(chunk);
    }
    callback();
  }
}

/** Human-friendly numbered prompts with q-to-cancel behavior. */
export class TerminalSetupPrompts implements SetupPrompts {
  private readonly proxy: MuteableOutput;
  private readonly readline: Interface;
  private readonly queuedLines: string[] = [];
  private pendingInput: {
    resolve(answer: string): void;
    reject(error: Error): void;
  } | null = null;
  private inputEnded = false;
  private closed = false;

  constructor(
    private readonly inputStream: NodeJS.ReadableStream = process.stdin,
    private readonly outputStream: NodeJS.WritableStream = process.stdout,
  ) {
    this.proxy = new MuteableOutput(outputStream);
    this.readline = createInterface({
      input: inputStream,
      output: this.proxy,
      terminal: Boolean((inputStream as NodeJS.ReadStream).isTTY),
    });
    this.readline.on("line", (line) => this.acceptLine(line));
    this.readline.on("close", () => this.acceptEndOfInput());
    this.readline.on("SIGINT", () => this.cancelPendingInput("Setup interrupted"));
  }

  /** Print a major setup step. */
  heading(title: string): void {
    this.write(`\n${title}\n${"─".repeat(Math.min(72, title.length + 8))}\n`);
  }

  /** Print neutral explanatory text. */
  info(message: string): void {
    this.write(`${message}\n`);
  }

  /** Print a visible warning without terminal-specific color assumptions. */
  warn(message: string): void {
    this.write(`Warning: ${message}\n`);
  }

  /** Print a completed-step message. */
  success(message: string): void {
    this.write(`Done: ${message}\n`);
  }

  /** Ask for one numbered choice, retrying invalid input. */
  async select<T extends string>(
    message: string,
    choices: SetupChoice<T>[],
    defaultValue?: T,
  ): Promise<T> {
    if (choices.length === 0) throw new Error(`No choices available for: ${message}`);
    this.printChoices(choices);
    const defaultIndex = defaultValue === undefined
      ? undefined
      : choices.findIndex((choice) => choice.value === defaultValue);
    while (true) {
      const suffix = defaultIndex !== undefined && defaultIndex >= 0
        ? ` [${defaultIndex + 1}]`
        : "";
      const answer = (await this.ask(`${message}${suffix} (q cancels): `)).trim();
      if (answer.toLowerCase() === "q") throw new SetupCancelledError();
      if (answer === "" && defaultIndex !== undefined && defaultIndex >= 0) {
        return choices[defaultIndex].value;
      }
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) {
        return choices[index].value;
      }
      this.warn(`Enter a number from 1 to ${choices.length}.`);
    }
  }

  /** Ask for zero or more comma-separated numbered choices. */
  async multiSelect<T extends string>(
    message: string,
    choices: SetupChoice<T>[],
    defaultValues: T[] = [],
  ): Promise<T[]> {
    if (choices.length === 0) return [];
    this.printChoices(choices, new Set(defaultValues));
    while (true) {
      const answer = (await this.ask(
        `${message} (comma-separated, all, none, q cancels) [default marked]: `,
      )).trim().toLowerCase();
      if (answer === "q") throw new SetupCancelledError();
      if (answer === "") return [...defaultValues];
      if (answer === "all") return choices.map((choice) => choice.value);
      if (answer === "none") return [];

      const indexes = answer.split(",").map((part) => Number(part.trim()) - 1);
      if (indexes.every((index) => Number.isInteger(index) && index >= 0 && index < choices.length)) {
        return [...new Set(indexes.map((index) => choices[index].value))];
      }
      this.warn(`Use numbers from 1 to ${choices.length}, separated by commas.`);
    }
  }

  /** Ask for free text with an optional default. */
  async input(message: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = await this.ask(`${message}${suffix}: `);
    return answer.trim() || defaultValue || "";
  }

  /** Read a value while suppressing terminal echo and readline redraws. */
  async secret(message: string): Promise<string> {
    this.write(`${message}: `);
    this.proxy.muted = true;
    try {
      const answer = await this.ask("");
      return answer.trim();
    } finally {
      this.proxy.muted = false;
      this.write("\n");
    }
  }

  /** Ask a yes/no question with a stable default. */
  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const answer = (await this.ask(`${message} [${hint}, q cancels]: `)).trim().toLowerCase();
      if (answer === "q") throw new SetupCancelledError();
      if (answer === "") return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.warn("Enter y or n.");
    }
  }

  /** Release readline resources. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
  }

  /** Render selection choices with descriptions and default markers. */
  private printChoices<T extends string>(
    choices: SetupChoice<T>[],
    defaults = new Set<T>(),
  ): void {
    choices.forEach((choice, index) => {
      const marker = defaults.has(choice.value) ? "x" : " ";
      this.write(`  ${index + 1}. [${marker}] ${choice.label}\n`);
      if (choice.description) this.write(`       ${choice.description}\n`);
    });
  }

  /**
   * Ask one question from a durable line queue.
   *
   * KEYPOINT: pipes can deliver every line and EOF before the first prompt
   * runs. Buffer those lines instead of calling readline.question() once per
   * prompt, which drops unread input on non-TTY streams.
   */
  private ask(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new SetupCancelledError("Input is closed"));
    this.write(prompt);
    const queued = this.queuedLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.inputEnded) {
      return Promise.reject(new SetupCancelledError("Input ended before setup completed"));
    }
    return new Promise<string>((resolve, reject) => {
      this.pendingInput = { resolve, reject };
    });
  }

  /** Deliver a line immediately or retain it for the next prompt. */
  private acceptLine(line: string): void {
    if (this.pendingInput) {
      const pending = this.pendingInput;
      this.pendingInput = null;
      pending.resolve(line);
      return;
    }
    this.queuedLines.push(line);
  }

  /** Mark EOF while preserving any lines already buffered by a pipe. */
  private acceptEndOfInput(): void {
    this.inputEnded = true;
    if (this.queuedLines.length === 0) {
      this.cancelPendingInput("Input ended before setup completed");
    }
  }

  /** Reject the active prompt without discarding previously buffered lines. */
  private cancelPendingInput(reason: string): void {
    if (!this.pendingInput) return;
    const pending = this.pendingInput;
    this.pendingInput = null;
    pending.reject(new SetupCancelledError(reason));
  }

  /** Write directly to the real output stream. */
  private write(text: string): void {
    this.outputStream.write(text);
  }
}
