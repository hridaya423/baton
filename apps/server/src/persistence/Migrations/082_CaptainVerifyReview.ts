import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN verify_json TEXT`;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN review_json TEXT`;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN followup_text TEXT`;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN claimed_at TEXT`;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN stall_level INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE captain_escalations (
    escalation_id TEXT PRIMARY KEY,
    captain_id TEXT NOT NULL REFERENCES captains(captain_id) ON DELETE CASCADE,
    order_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'approval', 'one_way_door', 'retry_limit', 'budget', 'stall', 'conflict')),
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    options_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    resolution TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`;
  yield* sql`CREATE INDEX idx_captain_escalations_captain_status ON captain_escalations(captain_id, status)`;
});
