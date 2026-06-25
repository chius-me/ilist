export interface PasswordInput {
  isTTY?: boolean;
  setEncoding?(encoding: string): void;
  setRawMode?(enabled: boolean): void;
  resume?(): void;
  pause?(): void;
  on(event: string, listener: (value?: unknown) => void): void;
  off(event: string, listener: (value?: unknown) => void): void;
  [Symbol.asyncIterator]?(): AsyncIterator<string | Uint8Array>;
}

export interface PasswordErrorOutput {
  write(value: string): unknown;
}

export function readHiddenTtyPassword(input: PasswordInput, errorOutput: PasswordErrorOutput): Promise<string>;
export function readPasswordInput(input: PasswordInput, errorOutput: PasswordErrorOutput): Promise<string>;
