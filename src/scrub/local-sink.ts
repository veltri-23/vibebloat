import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export class LocalOnlySink {
  readonly #root: string;

  constructor(directory: string) {
    this.#root = resolve(directory);
  }

  async store(payload: string): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await Bun.write(join(this.#root, `${crypto.randomUUID()}.json`), payload);
  }
}

export function createLocalOnlySink(directory: string): LocalOnlySink {
  return new LocalOnlySink(directory);
}
