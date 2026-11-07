export type Unsubscribe = () => void;

/** Minimal listener set. Exceptions in one listener never stop the others. */
export class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>();

  add(cb: (...args: A) => void): Unsubscribe {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }

  emit(...args: A): void {
    for (const cb of Array.from(this.set)) {
      try {
        cb(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }

  get size(): number {
    return this.set.size;
  }

  clear(): void {
    this.set.clear();
  }
}

/** Serialises async critical sections (FIFO). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
