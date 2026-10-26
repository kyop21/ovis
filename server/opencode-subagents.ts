/**
 * An OpenCode pane's subagents, counted and listed as a Claude Code pane's are
 * (server/claude-subagents.ts), from the store the chat reads (server/opencode.ts).
 *
 * OpenCode 2 runs a subagent in a child session of the session that started it: a `session_v2`
 * row whose `parent_id` names that session, with `session_message` rows of its own (the
 * `subagent` tool, packages/core/src/tool/plugin/subagent.ts in 2.0.32; a plugin that starts
 * subagents makes the same child sessions). Whether one still runs is told by its own rows: when
 * a run of a session ends, OpenCode appends an `idle` row with its outcome (`succeeded`,
 * `failed`, `interrupted`; session/projector.ts), and a later prompt to the same child (the tool
 * called again with its sessionID) starts another run, with rows after that one. A store
 * OpenCode 1.x wrote and 2.0 migrated has no idle rows: there a step that finished for anything
 * but its tool calls, or with an error, ended the run.
 *
 * The runs belong to OpenCode's background service, not to the TUI in the pane: a service that
 * stopped without an idle row (a crash, a kill) took its runs with it, so a run last written
 * before the service now running started is lost, as a Claude Code subagent from before its
 * process is.
 *
 * The parent records only the call (and, for a background call, the `synthetic` row that wakes
 * it with the result, which the chat draws as the ended subagent's card: server/opencode.ts).
 */
import type { Database } from "bun:sqlite";

import type { HerdrPane } from "../shared/protocol.ts";
import type { OmoTask } from "../shared/tasks.ts";
import { opencodeSessionId, withStore } from "./opencode.ts";

/** As for Claude Code and OmO: the newest ten that ended in the last day are listed. */
const RECENT_MS = 24 * 60 * 60_000;
const RECENT_LIMIT = 10;
/**
 * A session's ended children are read up to this many, newest first, for the list: a session that started more is still
 * read in bounded time. One whose run has not ended is read however many newer ones did: it counts.
 */
const MAX_CHILDREN = 1024;
/** A run written this long before the service's start may still be the service's own (its start is read in whole ticks). */
const START_SLACK_MS = 5_000;
/** The rows a run is made of: what an end or a new run is read from (instructions, agent switches are not). */
const RUN_ROWS = "('user', 'synthetic', 'assistant', 'idle', 'shell', 'compaction')";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const parse = (data: unknown): Row => { try { return record(JSON.parse(String(data))); } catch { return {}; } };
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const stamp = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

export interface OpencodeSubagentState {
  /** running ones first (oldest first), then up to ten that ended in the last day (newest first) */
  tasks: OmoTask[];
  running: number;
  /** of those running, how many the turn going on (or last ended) started: server/background-wait.ts */
  turnRunning: number;
  /** when the person last gave the parent session a prompt: that turn began there */
  promptAt: number | null;
}

const NOTHING: OpencodeSubagentState = { tasks: [], running: 0, turnRunning: 0, promptAt: null };

/** A child's newest run row, as much of it as tells how the run went. */
interface ChildRun {
  id: string; created: number; type: string; at: number;
  outcome: unknown; created_at: unknown; completed: unknown; finish: unknown; error: string | null; error_type: unknown;
}

/** How a run ended, or null while it runs. */
function runEnd(run: ChildRun): { status: Exclude<OmoTask["status"], "running" | "lost">; at: number } | null {
  if (run.type === "idle") {
    const status = run.outcome === "failed" ? "failed" : run.outcome === "interrupted" ? "cancelled" : "completed";
    return { status, at: stamp(run.created_at) ?? run.at };
  }
  // 1.x wrote no idle row: an answered step ended the run, or one that failed or was stopped
  const completed = stamp(run.completed);
  if (run.type === "assistant" && completed !== null) {
    if (run.error !== null && run.error !== "null") return { status: run.error_type === "aborted" ? "cancelled" : "failed", at: completed };
    if (typeof run.finish === "string" && run.finish !== "tool-calls") return { status: "completed", at: completed };
  }
  return null;
}

/** What a child did, for the list: its steps, tool calls, the model it last ran at and the context its last step held. */
function childWork(db: Database, id: string): { turns: number; toolCalls: number; tokens: number | null; model: string | null } {
  const steps = db.query<{ steps: number }, [string]>("SELECT count(*) AS steps FROM session_message WHERE session_id = ? AND type = 'assistant'").get(id)?.steps ?? 0;
  const tools = db.query<{ tools: number }, [string]>(
    "SELECT count(*) AS tools FROM session_message AS m, json_each(m.data, '$.content') AS c WHERE m.session_id = ? AND m.type = 'assistant' AND json_valid(m.data) AND json_extract(c.value, '$.type') = 'tool'",
  ).get(id)?.tools ?? 0;
  const last = db.query<{ data: string }, [string]>("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1").get(id);
  const data = last === null ? {} : parse(last.data);
  const usage = record(data.tokens);
  const cache = record(usage.cache);
  // the figure OpenCode's own footer shows, as the chat's ring reads it (server/opencode.ts)
  const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write);
  return { turns: steps, toolCalls: tools, tokens: used > 0 ? used : null, model: label(record(data.model).id) };
}

/**
 * A session's subagents, read from an open store. `live`: the pane still runs OpenCode on this
 * session; one that does not leaves what was running as lost, ended when it was last heard of.
 * `serviceStart`: when OpenCode's service started, when known (see above). `detail`: read what
 * each listed one did (its steps, tool calls, tokens), which a count does not need.
 */
export function readSubagents(db: Database, sessionId: string, live: boolean, now: number, serviceStart: number | null, detail: boolean): OpencodeSubagentState {
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('session_v2')").all().map((column) => column.name));
  // 1.x tables, or a 2.0 store from before child sessions: no subagents to tell of
  if (!columns.has("parent_id")) return NOTHING;
  // every child's newest run row, in one read, without the row's whole data (a step can be large): each one whose run
  // has not ended with an idle row is classified, and of the ended ones the newest, for the list
  let ended = 0;
  const runs = db.query<ChildRun, [string]>(`
    SELECT s.id, s.time_created AS created, m.type, m.time_created AS at,
      ${["outcome:$.outcome", "created_at:$.time.created", "completed:$.time.completed", "finish:$.finish", "error_type:$.error.type"]
    .map((field) => field.split(":")).map(([name, path]) => `CASE WHEN json_valid(m.data) THEN json_extract(m.data, '${path}') END AS ${name}`).join(", ")},
      CASE WHEN json_valid(m.data) THEN json_type(m.data, '$.error') END AS error
    FROM session_v2 AS s JOIN session_message AS m ON m.id = (
      SELECT id FROM session_message WHERE session_id = s.id AND type IN ${RUN_ROWS} ORDER BY seq DESC LIMIT 1)
    WHERE s.parent_id = ?${columns.has("time_archived") ? " AND s.time_archived IS NULL" : ""}
    ORDER BY s.time_created DESC`).all(sessionId).filter((run) => run.type !== "idle" || ++ended <= MAX_CHILDREN);
  const prompt = db.query<{ data: string; time_created: number }, [string]>(
    "SELECT data, time_created FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1",
  ).get(sessionId);
  const promptAt = prompt === null ? null : stamp(record(parse(prompt.data).time).created) ?? prompt.time_created;
  const lastAt = (run: ChildRun): number => stamp(run.completed) ?? stamp(run.created_at) ?? run.at;
  const ends = new Map(runs.map((run) => [run.id, runEnd(run)]));
  const orphan = (run: ChildRun): boolean => serviceStart !== null && lastAt(run) < serviceStart - START_SLACK_MS;
  const going = runs.filter((run) => ends.get(run.id) === null && live && !orphan(run));
  const stopped = runs.filter((run) => !going.includes(run))
    .map((run) => ({ run, at: ends.get(run.id)?.at ?? lastAt(run) }))
    .filter((entry) => now - entry.at <= RECENT_MS)
    .sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
  // one continued by its sessionID belongs to the turn that sent it its prompt
  const dispatched = db.query<{ time_created: number }, [string]>(
    "SELECT time_created FROM session_message WHERE session_id = ? AND type IN ('user', 'synthetic') ORDER BY seq DESC LIMIT 1",
  );
  const turnRunning = promptAt === null ? going.length : going.filter((run) => (dispatched.get(run.id)?.time_created ?? run.created) >= promptAt).length;
  const shown = [...going.sort((a, b) => a.created - b.created).map((run) => ({ run, at: null as number | null })), ...stopped];
  const about = db.query<{ title: string | null; agent: string | null; model: string | null }, [string]>(
    `SELECT ${["title", "agent", "model"].map((name) => columns.has(name) ? name : `NULL AS ${name}`).join(", ")} FROM session_v2 WHERE id = ?`,
  );
  const tasks = shown.map(({ run, at }): OmoTask => {
    const child = about.get(run.id);
    const end = ends.get(run.id) ?? null;
    const work = detail ? childWork(db, run.id) : null;
    return {
      id: run.id,
      title: label(child?.title) ?? label(child?.agent) ?? run.id,
      category: label(child?.agent),
      model: work?.model ?? label(record(parse(child?.model)).id),
      status: end !== null ? end.status : at === null ? "running" : "lost",
      started_at: iso(run.created),
      ended_at: iso(at),
      turns: work?.turns ?? null,
      tool_calls: work?.toolCalls ?? null,
      tokens: work?.tokens ?? null,
      // a child's work has no detail sheet (that reads a Claude Code subagent's transcript): this bridge knows the field
      detail_kind: null,
    };
  });
  return { tasks, running: going.length, turnRunning, promptAt };
}

/** readSubagents on the store at `path`; null when it cannot be read now. */
export function opencodeSubagentState(path: string, sessionId: string, live: boolean, now = Date.now(), serviceStart: number | null = null, detail = true): OpencodeSubagentState | null {
  try { return withStore(path, (db) => readSubagents(db, sessionId, live, now, serviceStart, detail)); }
  catch { return null; }
}

export interface OpencodeSubagentDeps {
  /** OpenCode's store: the one this server is configured with, else where OpenCode keeps it */
  store: () => string | null;
  /** when OpenCode's background service started, when it can be told now: read on every poll, so never waited for */
  serviceStart?: () => number | null;
  /**
   * The pane runs a session from now: another one, or one it came back to (`first` false: no earlier turn's wait is its
   * own), or its first after another agent (`first`: what the other agent's turns left is not its own; what OpenCode was
   * seen do there since, before its session was found, is).
   */
  onReset?: (paneId: string, first: boolean) => void;
  /** A pane's running subagents changed, or how many of them its turn started: no turn started or ended. */
  onChange: (paneId: string, running: number, turnRunning: number, promptAt: number | null) => void;
  pollMs?: number;
  now?: () => number;
}

interface Tracked { session: string; live: boolean; running: number; turnRunning: number; promptAt: number | null; reset: boolean }

/**
 * The running subagents of every OpenCode pane, for the pane's count. The session is the one
 * herdr's OpenCode integration reports (opencodeSessionId), never a guess. A pane that no longer
 * runs that session (at OpenCode's home screen, which reports none, or running another program)
 * keeps it, so that its list can say what was left running there is lost; its count is 0.
 */
export class OpencodeSubagentStatus {
  private readonly panes = new Map<string, Tracked>();
  /** each pane's agent as last seen: whether the first session it runs follows another agent's */
  private readonly agents = new Map<string, string | null>();
  /** reads of herdr's panes, numbered as they begin, and the newest taken for each pane: an older one never undoes it */
  private reads = 0;
  private readonly lastRead = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: OpencodeSubagentDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  /** The store and session the pane holds, or last held, and whether it still runs OpenCode on it. */
  sessionOf(paneId: string): { path: string; session: string; live: boolean } | null {
    const tracked = this.panes.get(paneId);
    const path = this.deps.store();
    return tracked && path !== null ? { path, session: tracked.session, live: tracked.live } : null;
  }

  /** A pane's list, as the background tasks route answers it; null when the store cannot be read now. */
  tasksOf(paneId: string): OmoTask[] | null {
    const known = this.sessionOf(paneId);
    if (known === null) return [];
    return opencodeSubagentState(known.path, known.session, known.live, this.now(), this.deps.serviceStart?.() ?? null)?.tasks ?? null;
  }

  /** Numbers a read of herdr's panes as it begins, before it is awaited: what refresh and ensure are given. */
  beginRead(): number {
    return ++this.reads;
  }

  /** The OpenCode panes of a snapshot (`read`: when its read began) and their sessions; a pane whose binding moved is read now. */
  refresh(panes: HerdrPane[], read = this.beginRead()): void {
    const ids = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.lastRead.keys()]) {
      if (ids.has(paneId) || this.newer(paneId, read)) continue;
      this.panes.delete(paneId);
      this.agents.delete(paneId);
      this.lastRead.delete(paneId);
    }
    const moved = panes.filter((pane) => this.ensure(pane, read));
    if (moved.length > 0) this.poll(new Set(moved.map((pane) => pane.pane_id)));
  }

  /** Whether a read of the pane begun after `read` was taken already. */
  private newer(paneId: string, read: number): boolean {
    return (this.lastRead.get(paneId) ?? 0) > read;
  }

  /** One pane's session, as herdr reports it (`read`: when that read began); true when its binding changed. */
  ensure(pane: HerdrPane, read = this.beginRead()): boolean {
    if (this.newer(pane.pane_id, read)) return false;
    this.lastRead.set(pane.pane_id, read);
    const tracked = this.panes.get(pane.pane_id);
    const before = this.agents.get(pane.pane_id);
    this.agents.set(pane.pane_id, pane.agent ?? null);
    const session = pane.agent === "opencode" ? opencodeSessionId(pane) : null;
    if (session === null) {
      if (!tracked?.live) return false;
      tracked.live = false;
      return true;
    }
    // the pane runs this session from here: a wait the agent before it held is not this one's
    if (tracked?.session === session) {
      if (tracked.live) return false;
      tracked.live = true;
      this.deps.onReset?.(pane.pane_id, false);
      return true;
    }
    // another session than the one it ran, or the first after another agent's: a new lifetime. The first
    // session of a pane seen new, at a shell or at OpenCode's home screen is found after its turn began,
    // maybe after it ended: what that turn was seen do is this session's
    if (tracked !== undefined) this.deps.onReset?.(pane.pane_id, false);
    else if (before != null && before !== "opencode") this.deps.onReset?.(pane.pane_id, true);
    this.panes.set(pane.pane_id, { session, live: true, running: tracked?.running ?? 0, turnRunning: tracked?.turnRunning ?? 0, promptAt: tracked?.promptAt ?? null, reset: tracked !== undefined });
    return true;
  }

  /** Reads the store once for every pane, or for some (a turn just ended there); a pane whose counts changed is told. */
  poll(only?: string | ReadonlySet<string>): void {
    const path = this.deps.store();
    const wanted = (paneId: string): boolean => only === undefined || (typeof only === "string" ? only === paneId : only.has(paneId));
    const states = new Map<string, OpencodeSubagentState>();
    const live = [...this.panes].filter(([paneId, tracked]) => wanted(paneId) && tracked.live);
    if (path !== null && live.length > 0) {
      const serviceStart = this.deps.serviceStart?.() ?? null;
      // one read for all: a store held by its writer is waited on once, not once per pane
      try {
        // on the event loop: a store its writer holds is not waited for
        withStore(path, (db) => {
          for (const [paneId, tracked] of live) states.set(paneId, readSubagents(db, tracked.session, true, this.now(), serviceStart, false));
        }, 0);
      } catch { /* a store busy for a moment says nothing: the counts stand */ }
    }
    for (const [paneId, tracked] of this.panes) {
      if (!wanted(paneId)) continue;
      const state = tracked.live ? states.get(paneId) : NOTHING;
      if (state === undefined) continue;
      const { running, turnRunning, promptAt } = state;
      if (!tracked.reset && running === tracked.running && turnRunning === tracked.turnRunning && promptAt === tracked.promptAt) continue;
      tracked.reset = false;
      tracked.running = running;
      tracked.turnRunning = turnRunning;
      tracked.promptAt = promptAt;
      this.deps.onChange(paneId, running, turnRunning, promptAt);
    }
  }
}
