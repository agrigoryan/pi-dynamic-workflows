import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Journaled agent-call results, so an interrupted or edited workflow can be resumed
 * without re-running (and re-paying for) completed agents.
 *
 * Matching is keyed, not purely positional: each entry is keyed by
 * sha256(prompt + normalized options) plus an occurrence counter for repeated
 * identical calls. Editing one agent() call invalidates only that call; unchanged
 * calls replay from cache regardless of completion-order jitter in parallel stages.
 */

export interface JournalEntry {
  key: string;
  occurrence: number;
  label: string;
  result: unknown;
  usage?: { input: number; output: number; totalTokens: number; cost: number };
}

export interface RunRecord {
  runId: string;
  name: string;
  description: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  finishedAt?: string;
  agentCount?: number;
  error?: string;
}

export function workflowsRoot(): string {
  return process.env.PI_DYNAMIC_WORKFLOWS_DIR ?? join(homedir(), ".pi", "dynamic-workflows");
}

export function projectRunsDir(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join(workflowsRoot(), "projects", slug);
}

export function newRunId(): string {
  return `wf_${randomBytes(5).toString("hex")}`;
}

export function agentCallKey(prompt: string, options: Record<string, unknown>): string {
  const normalized = JSON.stringify({
    prompt,
    schema: options.schema ?? null,
    model: options.model ?? null,
    agentType: options.agentType ?? null,
  });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export class RunJournal {
  readonly runId: string;
  readonly dir: string;
  private readonly cached = new Map<string, JournalEntry[]>();
  private readonly consumed = new Map<string, number>();

  constructor(cwd: string, runId: string) {
    this.runId = runId;
    this.dir = join(projectRunsDir(cwd), runId);
    mkdirSync(this.dir, { recursive: true });
  }

  private get journalPath(): string {
    return join(this.dir, "journal.jsonl");
  }

  /** Load a previous run's journal into the replay cache. */
  loadReplayCache(cwd: string, previousRunId: string): number {
    const runDir = join(projectRunsDir(cwd), previousRunId);
    if (!existsSync(runDir)) throw new Error(`no run found with id ${previousRunId}`);
    const path = join(runDir, "journal.jsonl");
    // A run whose agents all failed journaled nothing; resume just re-runs everything.
    if (!existsSync(path)) return 0;
    let count = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        const list = this.cached.get(entry.key) ?? [];
        list.push(entry);
        this.cached.set(entry.key, list);
        count++;
      } catch {
        // Ignore a torn trailing line from an interrupted write.
      }
    }
    return count;
  }

  /** Replay a cached result for this call key, consuming one occurrence. */
  replay(key: string): JournalEntry | undefined {
    const list = this.cached.get(key);
    if (!list?.length) return undefined;
    const occurrence = this.consumed.get(key) ?? 0;
    const entry = list.find((item) => item.occurrence === occurrence);
    if (!entry) return undefined;
    this.consumed.set(key, occurrence + 1);
    return entry;
  }

  nextOccurrence(key: string): number {
    const occurrence = this.consumed.get(key) ?? 0;
    this.consumed.set(key, occurrence + 1);
    return occurrence;
  }

  record(entry: JournalEntry): void {
    appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  saveScript(script: string): string {
    const path = join(this.dir, "script.js");
    writeFileSync(path, script, "utf8");
    return path;
  }

  saveRecord(record: RunRecord): void {
    writeFileSync(join(this.dir, "run.json"), JSON.stringify(record, null, 2), "utf8");
  }
}

export function listRuns(cwd: string, limit = 20): RunRecord[] {
  const dir = projectRunsDir(cwd);
  if (!existsSync(dir)) return [];
  const records: RunRecord[] = [];
  for (const entry of readdirSync(dir)) {
    const recordPath = join(dir, entry, "run.json");
    if (!existsSync(recordPath)) continue;
    try {
      records.push(JSON.parse(readFileSync(recordPath, "utf8")) as RunRecord);
    } catch {
      // Skip unreadable records.
    }
  }
  records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return records.slice(0, limit);
}
