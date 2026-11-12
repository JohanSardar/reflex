// What a profile run reports: one line per check, and a summary.
export interface Check {
  name: string;
  problems: string[];
}

export class Report {
  readonly checks: Check[] = [];
  readonly profile: string;
  readonly impl: string;
  constructor(profile: string, impl: string) {
    this.profile = profile;
    this.impl = impl;
  }

  check(name: string, problems: string[]): void {
    this.checks.push({ name, problems });
    const mark = problems.length ? "✗" : "✓";
    process.stdout.write(`  ${mark} ${name}${problems.length ? "\n" + problems.map((p) => `      ${p}`).join("\n") : ""}\n`);
  }

  /** Runs one check; a thrown error is its problem. */
  async run(name: string, fn: () => Promise<string[]> | string[]): Promise<void> {
    try {
      this.check(name, await fn());
    } catch (e) {
      this.check(name, [(e as Error).message]);
    }
  }

  get failed(): number {
    return this.checks.filter((c) => c.problems.length).length;
  }
}
