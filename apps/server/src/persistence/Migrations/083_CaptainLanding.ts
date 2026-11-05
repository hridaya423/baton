import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN land_json TEXT`;
  yield* sql`ALTER TABLE captain_orders ADD COLUMN pr_url TEXT`;
});
