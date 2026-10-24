import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { handleTasksRequest } from "./tasks-routes.ts";
import { opencodeSubagentState, OpencodeSubagentStatus } from "./opencode-subagents.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-opencode-subagents-"));
const opened: Database[] = [];
afterAll(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });

// The columns OpenCode 2.0.32 gives a session and the ones this reader asks of it.
const SCHEMA = `
CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text, version text NOT NULL, revert text, agent text, model text,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE INDEX session_v2_parent_idx ON session_v2 (parent_id);
`;

const NOW = Date.parse("2026-10-24T12:00:00Z");
const MIN = 60_000;
let stores = 0;
let rows = 0;

/** A store with one parent session, and writers for its rows and its children's, as OpenCode's service writes them. */
function store(parent = "ses_parent") {
  const path = join(root, `opencode-${++stores}.db`);
  const db = new Database(path, { create: true });
  opened.push(db);
  // these stores test what is read, not crash durability
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF");
  db.exec(SCHEMA);
  const session = (id: string, at: number, extra: { parent?: string | null; title?: string | null; agent?: string; model?: string; archived?: number } = {}) =>
    db.query("INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model, time_created, time_updated, time_archived) VALUES (?, 'global', ?, 'slug', ?, ?, '2.0.32', ?, ?, ?, ?, ?)")
      .run(id, extra.parent === undefined ? parent : extra.parent, root, extra.title === undefined ? `task ${id}` : extra.title, extra.agent ?? "explore", extra.model ?? JSON.stringify({ id: "session-model", providerID: "p" }), at, at, extra.archived ?? null);
  session(parent, NOW - 60 * MIN, { parent: null, title: "Parent", agent: "build" });
  const seqs = new Map<string, number>();
  const add = (sessionId: string, type: string, at: number, data: Record<string, unknown>) => {
    const seq = (seqs.get(sessionId) ?? 0) + 2;
    seqs.set(sessionId, seq);
    db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`msg_${(++rows).toString().padStart(6, "0")}`, sessionId, type, seq, at, at, JSON.stringify(data));
  };
  const prompt = (sessionId: string, at: number) => add(sessionId, "user", at, { time: { created: at }, text: "do it" });
  const step = (sessionId: string, at: number, extra: Record<string, unknown> = {}) => add(sessionId, "assistant", at, {
    time: { created: at, completed: at + 1000 }, model: { id: "child-model", providerID: "p" }, finish: "tool-calls",
    content: [{ type: "text", text: "working" }, { type: "tool", name: "read", state: { status: "completed", input: {}, content: [] } }],
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } }, ...extra,
  });
  const idle = (sessionId: string, at: number, outcome = "succeeded") => add(sessionId, "idle", at, { time: { created: at }, outcome });
  return { path, db, parent, session, add, prompt, step, idle };
}

describe("an OpenCode session's subagents are its child sessions", () => {
  it("lists running ones first, oldest first, then the newest that ended, with what each did", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    // two running: one at work, and one continued by its sessionID after an earlier run ended
    s.session("ses_working", NOW - 20 * MIN, { title: "index the repo" });
    s.prompt("ses_working", NOW - 20 * MIN);
    s.step("ses_working", NOW - 19 * MIN);
    s.session("ses_continued", NOW - 50 * MIN, { title: "review", agent: "general" });
    s.prompt("ses_continued", NOW - 50 * MIN);
    s.step("ses_continued", NOW - 49 * MIN, { finish: "stop" });
    s.idle("ses_continued", NOW - 48 * MIN);
    s.prompt("ses_continued", NOW - 10 * MIN);
    // ended: succeeded, failed, interrupted
    s.session("ses_done", NOW - 40 * MIN, { title: "find the bug" });
    s.prompt("ses_done", NOW - 40 * MIN);
    s.step("ses_done", NOW - 39 * MIN);
    s.step("ses_done", NOW - 38 * MIN, { finish: "stop", content: [{ type: "text", text: "found it" }] });
    s.idle("ses_done", NOW - 37 * MIN);
    s.session("ses_failed", NOW - 35 * MIN);
    s.prompt("ses_failed", NOW - 35 * MIN);
    s.idle("ses_failed", NOW - 34 * MIN, "failed");
    s.session("ses_stopped", NOW - 33 * MIN);
    s.prompt("ses_stopped", NOW - 33 * MIN);
    s.idle("ses_stopped", NOW - 32 * MIN, "interrupted");
    // not listed: no run yet, ended over a day ago, archived, another session's
    s.session("ses_unprompted", NOW - 5 * MIN);
    s.session("ses_old", NOW - 30 * 60 * MIN);
    s.prompt("ses_old", NOW - 30 * 60 * MIN);
    s.idle("ses_old", NOW - 26 * 60 * MIN);
    s.session("ses_archived", NOW - 15 * MIN, { archived: NOW - MIN });
    s.prompt("ses_archived", NOW - 15 * MIN);
    s.session("ses_elsewhere", NOW - 15 * MIN, { parent: "ses_other" });
    s.prompt("ses_elsewhere", NOW - 15 * MIN);

    const state = opencodeSubagentState(s.path, s.parent, true, NOW)!;
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ["ses_continued", "running"], ["ses_working", "running"],
      ["ses_stopped", "cancelled"], ["ses_failed", "failed"], ["ses_done", "completed"],
    ]);
    expect(state.running).toBe(2);
    expect(state.promptAt).toBe(NOW - 30 * MIN);
    // both runs this turn sent: the continued one by its latest prompt, not when it was first made
    expect(state.turnRunning).toBe(2);
    const done = state.tasks.find((task) => task.id === "ses_done")!;
    expect(done).toEqual({
      id: "ses_done", title: "find the bug", category: "explore", model: "child-model", status: "completed",
      started_at: new Date(NOW - 40 * MIN).toISOString(), ended_at: new Date(NOW - 37 * MIN).toISOString(),
      turns: 2, tool_calls: 1, tokens: 1125, detail_kind: null,
    });
    // the model a child names before its first step is the session's own
    expect(state.tasks.find((task) => task.id === "ses_failed")!.model).toBe("session-model");
    expect(state.tasks.find((task) => task.id === "ses_continued")!.ended_at).toBeNull();
  });

  it("counts for the turn only what that turn started, and reads nothing for the list when only counting", () => {
    const s = store();
    s.session("ses_before", NOW - 20 * MIN);
    s.prompt("ses_before", NOW - 20 * MIN);
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_after", NOW - 5 * MIN);
    s.prompt("ses_after", NOW - 5 * MIN);
    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, false)!;
    expect([state.running, state.turnRunning, state.promptAt]).toEqual([2, 1, NOW - 10 * MIN]);
    expect(state.tasks.map((task) => [task.turns, task.tool_calls, task.tokens])).toEqual([[null, null, null], [null, null, null]]);
  });

  it("leaves what ran as lost once the pane no longer runs the session, ended when last heard of", () => {
    const s = store();
    s.session("ses_working", NOW - 20 * MIN);
    s.prompt("ses_working", NOW - 20 * MIN);
    s.step("ses_working", NOW - 19 * MIN);
    s.session("ses_done", NOW - 30 * MIN);
    s.prompt("ses_done", NOW - 30 * MIN);
    s.idle("ses_done", NOW - 29 * MIN);
    const state = opencodeSubagentState(s.path, s.parent, false, NOW)!;
    expect(state.tasks.map((task) => [task.id, task.status, task.ended_at])).toEqual([
      ["ses_working", "lost", new Date(NOW - 19 * MIN + 1000).toISOString()],
      ["ses_done", "completed", new Date(NOW - 29 * MIN).toISOString()],
    ]);
    expect(state.running).toBe(0);
  });

  it("ends a run OpenCode 1.x recorded, which has no idle row, at its answered, failed or stopped step", () => {
    const s = store();
    for (const [id, extra] of [
      ["ses_answered", { finish: "stop" }],
      ["ses_errored", { finish: undefined, error: { name: "APIError", message: "boom" } }],
      ["ses_aborted", { finish: undefined, error: { type: "aborted", message: "Aborted" } }],
      ["ses_calling", {}],
    ] as const) {
      s.session(id, NOW - 10 * MIN);
      s.prompt(id, NOW - 10 * MIN);
      s.step(id, NOW - 9 * MIN, extra);
    }
    expect(opencodeSubagentState(s.path, s.parent, true, NOW)!.tasks.map((task) => [task.id, task.status])).toEqual([
      ["ses_calling", "running"], ["ses_answered", "completed"], ["ses_errored", "failed"], ["ses_aborted", "cancelled"],
    ]);
  });

  it("leaves a run from before OpenCode's service started as lost: that service took it along", () => {
    const s = store();
    s.session("ses_orphan", NOW - 20 * MIN);
    s.prompt("ses_orphan", NOW - 20 * MIN);
    s.step("ses_orphan", NOW - 19 * MIN);
    s.session("ses_fresh", NOW - 2 * MIN);
    s.prompt("ses_fresh", NOW - 2 * MIN);
    const state = opencodeSubagentState(s.path, s.parent, true, NOW, NOW - 5 * MIN)!;
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([["ses_fresh", "running"], ["ses_orphan", "lost"]]);
    expect(state.running).toBe(1);
    // written in the seconds the service's start is read in: still its own
    expect(opencodeSubagentState(s.path, s.parent, true, NOW, NOW - 19 * MIN + 1000 + 3000)!.running).toBe(2);
  });

  it("counts a run however many newer children ended since, and lists only the newest ten that did", () => {
    const s = store();
    s.session("ses_early", NOW - 50 * MIN);
    s.prompt("ses_early", NOW - 50 * MIN);
    for (let n = 0; n < 70; n++) {
      s.session(`ses_done${n}`, NOW - 40 * MIN + n * 1000);
      s.prompt(`ses_done${n}`, NOW - 40 * MIN + n * 1000);
      s.idle(`ses_done${n}`, NOW - 30 * MIN + n * 1000);
    }
    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, false)!;
    expect(state.running).toBe(1);
    expect(state.tasks.map((task) => task.id)).toEqual(["ses_early", ...Array.from({ length: 10 }, (_, n) => `ses_done${69 - n}`)]);
  });

  it("reads every other child when one's newest row is not JSON", () => {
    const s = store();
    s.session("ses_broken", NOW - 10 * MIN);
    s.add("ses_broken", "user", NOW - 10 * MIN, {});
    s.db.query("UPDATE session_message SET data = '{not json' WHERE session_id = 'ses_broken'").run();
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, false)?.tasks.map((task) => [task.id, task.status])).toEqual([["ses_broken", "running"], ["ses_working", "running"]]);
  });

  it("finds no subagents in a store without child sessions, and says nothing of one it cannot read", () => {
    const path = join(root, "v1.db");
    const v1 = new Database(path, { create: true });
    opened.push(v1);
    v1.exec("CREATE TABLE session (id text PRIMARY KEY, title text); CREATE TABLE message (id text PRIMARY KEY, session_id text, data text);");
    expect(opencodeSubagentState(path, "ses_parent", true, NOW)).toEqual({ tasks: [], running: 0, turnRunning: 0, promptAt: null });
    const garbage = join(root, "garbage.db");
    writeFileSync(garbage, "not a database at all, just text");
    expect(opencodeSubagentState(garbage, "ses_parent", true, NOW)).toBeNull();
    expect(opencodeSubagentState(join(root, "missing.db"), "ses_parent", true, NOW)).toBeNull();
  });
});

describe("the OpenCode subagent tracker", () => {
  const pane = (session: string | null, agent = "opencode"): HerdrPane => ({
    pane_id: "w1:p1", agent, agent_status: "idle",
    ...(session === null ? {} : { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } }),
  } as HerdrPane);

  it("counts a pane's running subagents and tells each change once; a pane that leaves OpenCode counts none", () => {
    const s = store();
    const changes: unknown[] = [];
    const resets: string[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: (...args) => changes.push(args), onReset: (paneId) => resets.push(paneId) });
    tracker.refresh([pane(s.parent)]);
    // a pane seen first running its session: what its turn was seen do before is that session's
    expect(resets).toEqual([]);
    expect(changes).toEqual([]);
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    tracker.poll();
    expect(changes).toEqual([["w1:p1", 1, 1, NOW - 10 * MIN]]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    // the same store read again changes nothing
    tracker.poll();
    expect(changes).toHaveLength(1);
    s.idle("ses_working", NOW - MIN);
    tracker.poll("w1:p1");
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, NOW - 10 * MIN]);
    // started again, then OpenCode's home screen, which names no session: the pane runs it no more
    s.prompt("ses_working", NOW - 30_000);
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
    tracker.refresh([pane(null)]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, null]);
    expect(tracker.sessionOf("w1:p1")).toEqual({ path: s.path, session: s.parent, live: false });
    expect(tracker.tasksOf("w1:p1")?.map((task) => [task.id, task.status])).toEqual([["ses_working", "lost"]]);
    // back on that session, it counts again; then the pane runs a shell
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    expect(resets).toEqual(["w1:p1"]);
    tracker.refresh([pane(null, "shell")]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, null]);
    expect(tracker.sessionOf("w1:p1")).toEqual({ path: s.path, session: s.parent, live: false });
    expect(resets).toHaveLength(1);
    // another session in the pane: what the turn of the old one held goes
    tracker.refresh([pane("ses_next")]);
    expect(resets).toHaveLength(2);
    expect(tracker.sessionOf("w1:p1")?.session).toBe("ses_next");
    // a pane gone from the snapshot is forgotten
    tracker.refresh([]);
    expect(tracker.sessionOf("w1:p1")).toBeNull();
  });

  it("drops another agent's wait when a pane first runs a session after it, never what the pane's own OpenCode turn was seen do", () => {
    const s = store();
    const resets: string[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: () => undefined, onReset: (paneId) => resets.push(paneId) });
    // a shell, then OpenCode's home screen, then its session found after the turn: one OpenCode lifetime
    tracker.refresh([{ pane_id: "w1:p1", agent: null, agent_status: "idle" } as HerdrPane]);
    tracker.refresh([pane(null)]);
    tracker.refresh([pane(s.parent)]);
    expect(resets).toEqual([]);
    // a pane Claude Code ran until this snapshot
    tracker.refresh([{ ...pane(null, "claude"), pane_id: "w1:p2" }]);
    tracker.refresh([{ ...pane(s.parent), pane_id: "w1:p2" }]);
    expect(resets).toEqual(["w1:p2"]);
  });

  it("keeps the count while the store cannot be read", () => {
    const s = store();
    let path = s.path;
    const changes: unknown[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => path, now: () => NOW, onChange: (...args) => changes.push(args) });
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    path = join(root, "missing.db");
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
    expect(changes).toHaveLength(1);
  });

  it("answers the background tasks route with the pane's subagents, the live session's before a Claude one gone", async () => {
    const s = store();
    // the route reads on the PC's clock
    const now = Date.now();
    s.session("ses_working", now - 5 * MIN);
    s.prompt("ses_working", now - 5 * MIN);
    const ask = (live: boolean, claudeLive: boolean | null) => handleTasksRequest(
      new Request("http://localhost/api/pane/omo-tasks?pane_id=w1:p1"), new URL("http://localhost/api/pane/omo-tasks?pane_id=w1:p1"), "/api/pane/omo-tasks", {
        omo: { sessionOf: () => null },
        claudeAgents: { sessionOf: () => claudeLive === null ? null : { path: join(root, "absent.jsonl"), live: claudeLive, startedAt: null }, ensure: async () => undefined },
        opencodeAgents: { sessionOf: () => ({ path: s.path, session: s.parent, live }), ensure: () => false, tasksOf: () => opencodeSubagentState(s.path, s.parent, live)?.tasks ?? null },
      });
    const tasks = async (response: Response | null) => ((await response!.json()) as { tasks: { id: string; status: string }[] }).tasks.map((task) => [task.id, task.status]);
    expect(await tasks(await ask(true, null))).toEqual([["ses_working", "running"]]);
    expect(await tasks(await ask(false, false))).toEqual([["ses_working", "lost"]]);
    // the pane runs Claude Code now: its list is Claude's
    expect(await tasks(await ask(false, true))).toEqual([]);
  });
});
