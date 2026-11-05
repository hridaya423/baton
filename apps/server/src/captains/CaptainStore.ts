import {
  Captain,
  CaptainCharter,
  CaptainCrewReport,
  CaptainError,
  CaptainOrder,
  CaptainOrderId,
  CaptainPlacement,
  type CaptainId,
  type CaptainListInput,
  type CaptainOrderState,
  type CaptainStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const OrderIdArrayJson = Schema.fromJsonString(Schema.Array(CaptainOrderId));
const CharterJson = Schema.fromJsonString(CaptainCharter);
const PlacementJson = Schema.fromJsonString(CaptainPlacement);
const ReportJson = Schema.fromJsonString(CaptainCrewReport);

const encodeStringArray = Schema.encodeSync(StringArrayJson);
const encodeOrderIds = Schema.encodeSync(OrderIdArrayJson);
const encodeCharter = Schema.encodeSync(CharterJson);
const encodePlacement = Schema.encodeSync(PlacementJson);
const encodeReport = Schema.encodeSync(ReportJson);
const decodeStringArray = Schema.decodeUnknownEffect(StringArrayJson);
const decodeOrderIds = Schema.decodeUnknownEffect(OrderIdArrayJson);
const decodeCharter = Schema.decodeUnknownEffect(CharterJson);
const decodePlacement = Schema.decodeUnknownEffect(PlacementJson);
const decodeReport = Schema.decodeUnknownEffect(ReportJson);
const decodeCaptain = Schema.decodeUnknownEffect(Captain);
const decodeOrder = Schema.decodeUnknownEffect(CaptainOrder);

interface CaptainRow {
  readonly captain_id: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly status: string;
  readonly charter_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface OrderRow {
  readonly order_id: string;
  readonly captain_id: string;
  readonly thread_id: string | null;
  readonly kind: string;
  readonly title: string;
  readonly brief: string;
  readonly done_check: string | null;
  readonly touches_json: string;
  readonly depends_on_json: string;
  readonly placement_json: string;
  readonly delivery: string;
  readonly state: string;
  readonly retries: number;
  readonly branch: string | null;
  readonly base_ref: string | null;
  readonly report_md: string | null;
  readonly last_report_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_activity_at: string;
}

// Runs per row; the list operations that call it own the span.
const captainFromRow = Effect.fnUntraced(function* (row: CaptainRow) {
  return yield* decodeCaptain({
    id: row.captain_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    name: row.name,
    status: row.status,
    charter: yield* decodeCharter(row.charter_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

// Runs per row; the list operations that call it own the span.
const orderFromRow = Effect.fnUntraced(function* (row: OrderRow) {
  return yield* decodeOrder({
    id: row.order_id,
    captainId: row.captain_id,
    threadId: row.thread_id,
    kind: row.kind,
    title: row.title,
    brief: row.brief,
    doneCheck: row.done_check,
    touches: yield* decodeStringArray(row.touches_json),
    dependsOn: yield* decodeOrderIds(row.depends_on_json),
    placement: yield* decodePlacement(row.placement_json),
    delivery: row.delivery,
    state: row.state,
    retries: row.retries,
    branch: row.branch,
    baseRef: row.base_ref,
    reportMd: row.report_md,
    lastReport: row.last_report_json === null ? null : yield* decodeReport(row.last_report_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  });
});

const storage = Effect.mapError((cause: unknown) => new CaptainError({ reason: "storage", cause }));

export interface OrderClaim {
  readonly orderId: CaptainOrderId;
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly baseRef: string;
  readonly at: string;
}

export interface OrderReportWrite {
  readonly orderId: CaptainOrderId;
  readonly report: CaptainCrewReport;
  readonly reportMd: string | undefined;
  readonly state: CaptainOrderState;
}

export class CaptainStore extends Context.Service<
  CaptainStore,
  {
    readonly insertCaptain: (captain: Captain) => Effect.Effect<void, CaptainError>;
    readonly setCaptainStatus: (input: {
      readonly captainId: CaptainId;
      readonly status: CaptainStatus;
      readonly at: string;
    }) => Effect.Effect<void, CaptainError>;
    readonly getCaptain: (id: CaptainId) => Effect.Effect<Option.Option<Captain>, CaptainError>;
    readonly getCaptainByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<Captain>, CaptainError>;
    readonly listCaptains: (
      input: CaptainListInput,
    ) => Effect.Effect<ReadonlyArray<Captain>, CaptainError>;
    readonly insertOrder: (order: CaptainOrder) => Effect.Effect<void, CaptainError>;
    readonly getOrder: (
      id: CaptainOrderId,
    ) => Effect.Effect<Option.Option<CaptainOrder>, CaptainError>;
    readonly getOrderByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<CaptainOrder>, CaptainError>;
    /** Oldest first, which is the queue order. */
    readonly listOrders: (
      captainId: CaptainId,
    ) => Effect.Effect<ReadonlyArray<CaptainOrder>, CaptainError>;
    readonly listCrewOrders: () => Effect.Effect<ReadonlyArray<CaptainOrder>, CaptainError>;
    /** True when this call moved the order from queued to running. */
    readonly claimOrder: (claim: OrderClaim) => Effect.Effect<boolean, CaptainError>;
    /** True when the order was in one of `from` and is now `to`. */
    readonly transitionOrder: (input: {
      readonly orderId: CaptainOrderId;
      readonly from: ReadonlyArray<CaptainOrderState>;
      readonly to: CaptainOrderState;
      readonly at: string;
    }) => Effect.Effect<boolean, CaptainError>;
    readonly recordReport: (
      input: OrderReportWrite & { readonly at: string },
    ) => Effect.Effect<void, CaptainError>;
    readonly touchActivity: (input: {
      readonly orderId: CaptainOrderId;
      readonly at: string;
    }) => Effect.Effect<void, CaptainError>;
  }
>()("t3/captains/CaptainStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertCaptain = Effect.fn("CaptainStore.insertCaptain")(function* (captain: Captain) {
    yield* sql`
      INSERT INTO captains
        (captain_id, project_id, thread_id, name, status, charter_json, created_at, updated_at)
      VALUES
        (${captain.id}, ${captain.projectId}, ${captain.threadId}, ${captain.name},
         ${captain.status}, ${encodeCharter(captain.charter)}, ${captain.createdAt}, ${captain.updatedAt})
    `.pipe(storage);
  });

  const setCaptainStatus = Effect.fn("CaptainStore.setCaptainStatus")(function* (input: {
    readonly captainId: CaptainId;
    readonly status: CaptainStatus;
    readonly at: string;
  }) {
    yield* sql`
      UPDATE captains SET status = ${input.status}, updated_at = ${input.at}
      WHERE captain_id = ${input.captainId}
    `.pipe(storage);
  });

  const getCaptain = Effect.fn("CaptainStore.getCaptain")(function* (id: CaptainId) {
    const [row] = yield* sql<CaptainRow>`SELECT * FROM captains WHERE captain_id = ${id}`.pipe(
      storage,
    );
    return row === undefined
      ? Option.none<Captain>()
      : Option.some(yield* captainFromRow(row).pipe(storage));
  });

  const getCaptainByThread = Effect.fn("CaptainStore.getCaptainByThread")(function* (
    threadId: ThreadId,
  ) {
    const [row] = yield* sql<CaptainRow>`SELECT * FROM captains WHERE thread_id = ${threadId}`.pipe(
      storage,
    );
    return row === undefined
      ? Option.none<Captain>()
      : Option.some(yield* captainFromRow(row).pipe(storage));
  });

  const listCaptains = Effect.fn("CaptainStore.listCaptains")(function* (input: CaptainListInput) {
    const rows =
      input.projectId === undefined
        ? yield* sql<CaptainRow>`SELECT * FROM captains ORDER BY created_at ASC, rowid ASC`.pipe(
            storage,
          )
        : yield* sql<CaptainRow>`
            SELECT * FROM captains WHERE project_id = ${input.projectId}
            ORDER BY created_at ASC, rowid ASC
          `.pipe(storage);
    return yield* Effect.forEach(rows, captainFromRow).pipe(storage);
  });

  const insertOrder = Effect.fn("CaptainStore.insertOrder")(function* (order: CaptainOrder) {
    yield* sql`
      INSERT INTO captain_orders
        (order_id, captain_id, thread_id, kind, title, brief, done_check, touches_json,
         depends_on_json, placement_json, delivery, state, retries, branch, base_ref, report_md,
         last_report_json, created_at, updated_at, last_activity_at)
      VALUES
        (${order.id}, ${order.captainId}, ${order.threadId}, ${order.kind}, ${order.title},
         ${order.brief}, ${order.doneCheck}, ${encodeStringArray(order.touches)},
         ${encodeOrderIds(order.dependsOn)}, ${encodePlacement(order.placement)}, ${order.delivery},
         ${order.state}, ${order.retries}, ${order.branch}, ${order.baseRef}, ${order.reportMd},
         ${order.lastReport === null ? null : encodeReport(order.lastReport)},
         ${order.createdAt}, ${order.updatedAt}, ${order.lastActivityAt})
    `.pipe(storage);
  });

  const getOrder = Effect.fn("CaptainStore.getOrder")(function* (id: CaptainOrderId) {
    const [row] = yield* sql<OrderRow>`SELECT * FROM captain_orders WHERE order_id = ${id}`.pipe(
      storage,
    );
    return row === undefined
      ? Option.none<CaptainOrder>()
      : Option.some(yield* orderFromRow(row).pipe(storage));
  });

  const getOrderByThread = Effect.fn("CaptainStore.getOrderByThread")(function* (
    threadId: ThreadId,
  ) {
    const [row] = yield* sql<OrderRow>`
      SELECT * FROM captain_orders WHERE thread_id = ${threadId}
    `.pipe(storage);
    return row === undefined
      ? Option.none<CaptainOrder>()
      : Option.some(yield* orderFromRow(row).pipe(storage));
  });

  const listOrders = Effect.fn("CaptainStore.listOrders")(function* (captainId: CaptainId) {
    const rows = yield* sql<OrderRow>`
      SELECT * FROM captain_orders WHERE captain_id = ${captainId}
      ORDER BY created_at ASC, rowid ASC
    `.pipe(storage);
    return yield* Effect.forEach(rows, orderFromRow).pipe(storage);
  });

  const listCrewOrders = Effect.fn("CaptainStore.listCrewOrders")(function* () {
    const rows = yield* sql<OrderRow>`
      SELECT * FROM captain_orders WHERE thread_id IS NOT NULL AND state <> 'dropped'
    `.pipe(storage);
    return yield* Effect.forEach(rows, orderFromRow).pipe(storage);
  });

  const claimOrder = Effect.fn("CaptainStore.claimOrder")(function* (claim: OrderClaim) {
    const rows = yield* sql`
      UPDATE captain_orders
      SET state = 'running', thread_id = ${claim.threadId}, branch = ${claim.branch},
          base_ref = ${claim.baseRef}, updated_at = ${claim.at}, last_activity_at = ${claim.at}
      WHERE order_id = ${claim.orderId} AND state = 'queued'
      RETURNING order_id
    `.pipe(storage);
    return rows.length > 0;
  });

  const transitionOrder = Effect.fn("CaptainStore.transitionOrder")(function* (input: {
    readonly orderId: CaptainOrderId;
    readonly from: ReadonlyArray<CaptainOrderState>;
    readonly to: CaptainOrderState;
    readonly at: string;
  }) {
    const rows = yield* sql`
      UPDATE captain_orders SET state = ${input.to}, updated_at = ${input.at}
      WHERE order_id = ${input.orderId} AND state IN ${sql.in(input.from)}
      RETURNING order_id
    `.pipe(storage);
    return rows.length > 0;
  });

  const recordReport = Effect.fn("CaptainStore.recordReport")(function* (
    input: OrderReportWrite & { readonly at: string },
  ) {
    yield* sql`
      UPDATE captain_orders
      SET last_report_json = ${encodeReport(input.report)}, state = ${input.state},
          report_md = COALESCE(${input.reportMd ?? null}, report_md),
          updated_at = ${input.at}, last_activity_at = ${input.at}
      WHERE order_id = ${input.orderId}
    `.pipe(storage);
  });

  const touchActivity = Effect.fn("CaptainStore.touchActivity")(function* (input: {
    readonly orderId: CaptainOrderId;
    readonly at: string;
  }) {
    yield* sql`
      UPDATE captain_orders SET last_activity_at = ${input.at} WHERE order_id = ${input.orderId}
    `.pipe(storage);
  });

  return CaptainStore.of({
    insertCaptain,
    setCaptainStatus,
    getCaptain,
    getCaptainByThread,
    listCaptains,
    insertOrder,
    getOrder,
    getOrderByThread,
    listOrders,
    listCrewOrders,
    claimOrder,
    transitionOrder,
    recordReport,
    touchActivity,
  });
});

export const layer = Layer.effect(CaptainStore, make);
