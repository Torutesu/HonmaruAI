import type { Logger } from "./log.js";

type Handler = (payload: unknown) => Promise<void>;

interface Job {
  name: string;
  payload: unknown;
  attempts: number;
}

// In-process async job queue for work that must not sit in the request
// path (LLM refinement, external deliveries). Single worker loop with
// bounded retries and exponential backoff. Jobs are lost on process
// restart — acceptable for enrichment work, which is always recoverable
// from primary state; move to a table-backed queue if a job ever becomes
// the source of truth for anything.
export class JobQueue {
  private queue: Job[] = [];
  private running = false;
  private active = 0;

  constructor(
    private log: Logger,
    private handlers: Record<string, Handler>,
    private options: { maxAttempts?: number; backoffMs?: number } = {}
  ) {}

  enqueue(name: string, payload: unknown): void {
    if (!this.handlers[name]) {
      this.log.error({ job: name }, "no handler for job; dropping");
      return;
    }
    this.queue.push({ name, payload, attempts: 0 });
    void this.pump();
  }

  get pending(): number {
    return this.queue.length + this.active;
  }

  // Test helper: resolves when everything enqueued so far has settled.
  async drain(): Promise<void> {
    while (this.pending > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.active += 1;
        try {
          await this.handlers[job.name]!(job.payload);
        } catch (error) {
          job.attempts += 1;
          const maxAttempts = this.options.maxAttempts ?? 3;
          if (job.attempts < maxAttempts) {
            const delay =
              (this.options.backoffMs ?? 1000) * 2 ** (job.attempts - 1);
            this.log.warn(
              { job: job.name, attempt: job.attempts, delay, err: error },
              "job failed; retrying"
            );
            setTimeout(() => {
              this.queue.push(job);
              void this.pump();
            }, delay).unref?.();
          } else {
            this.log.error(
              { job: job.name, err: error },
              "job failed permanently"
            );
          }
        } finally {
          this.active -= 1;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
