/** Collects de-duplicated conversion warnings for one run (no global state). */
export class Warnings {
  private items = new Set<string>();

  add(message: string): void {
    this.items.add(message);
  }

  list(): string[] {
    return [...this.items];
  }
}
