import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE captains (
    captain_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'released')),
    charter_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE captain_orders (
    order_id TEXT PRIMARY KEY,
    captain_id TEXT NOT NULL REFERENCES captains(captain_id) ON DELETE CASCADE,
    thread_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('change', 'report')),
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    done_check TEXT,
    touches_json TEXT NOT NULL,
    depends_on_json TEXT NOT NULL,
    placement_json TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('none', 'branch', 'pr', 'merge')),
    state TEXT NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    branch TEXT,
    base_ref TEXT,
    report_md TEXT,
    last_report_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_captain_orders_captain_state ON captain_orders(captain_id, state)`;
  yield* sql`CREATE UNIQUE INDEX idx_captain_orders_thread ON captain_orders(thread_id) WHERE thread_id IS NOT NULL`;
});
