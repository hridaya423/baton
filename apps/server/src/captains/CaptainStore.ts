import {
  Captain,
  CaptainCharter,
  CaptainCrewReport,
  CaptainError,
  CaptainEscalation,
  type CaptainEscalationId,
  type CaptainEscalationKind,
  type CaptainEscalationStatus,
  CaptainOrder,
  CaptainOrderId,
  CaptainPlacement,
  CaptainReview,
  CaptainVerifyResult,
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
const VerifyJson = Schema.fromJsonString(CaptainVerifyResult);
const ReviewJson = Schema.fromJsonString(CaptainReview);

const encodeStringArray = Schema.encodeSync(StringArrayJson);
const encodeOrderIds = Schema.encodeSync(OrderIdArrayJson);
const encodeCharter = Schema.encodeSync(CharterJson);
const encodePlacement = Schema.encodeSync(PlacementJson);
const encodeReport = Schema.encodeSync(ReportJson);
const encodeVerify = Schema.encodeSync(VerifyJson);
const encodeReview = Schema.encodeSync(ReviewJson);
const decodeStringArray = Schema.decodeUnknownEffect(StringArrayJson);
const decodeOrderIds = Schema.decodeUnknownEffect(OrderIdArrayJson);
const decodeCharter = Schema.decodeUnknownEffect(CharterJson);
const decodePlacement = Schema.decodeUnknownEffect(PlacementJson);
const decodeReport = Schema.decodeUnknownEffect(ReportJson);
const decodeVerify = Schema.decodeUnknownEffect(VerifyJson);
const decodeReview = Schema.decodeUnknownEffect(ReviewJson);
const decodeEscalation = Schema.decodeUnknownEffect(CaptainEscalation);
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
  readonly verify_json: string | null;
  readonly review_json: string | null;
  readonly followup_text: string | null;
  readonly stall_level: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_activity_at: string;
}

interface EscalationRow {
  readonly escalation_id: string;
  readonly captain_id: string;
  readonly order_id: string | null;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string;
  readonly options_json: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
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
    verify: row.verify_json === null ? null : yield* decodeVerify(row.verify_json),
    review: row.review_json === null ? null : yield* decodeReview(row.review_json),
    pendingFollowUp: row.followup_text,
    stallLevel: row.stall_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  });
});

// Runs per row; the list operations that call it own the span.
const escalationFromRow = Effect.fnUntraced(function* (row: EscalationRow) {
  return yield* decodeEscalation({
    id: row.escalation_id,
    captainId: row.captain_id,
    orderId: row.order_id,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail,
    options: yield* decodeStringArray(row.options_json),
    status: row.status,
    resolution: row.resolution,
    requestId: row.request_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
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
  /** The state to move to, applied only when the order is in one of `from`. */
  readonly moveTo?: {
    readonly from: ReadonlyArray<CaptainOrderState>;
    readonly to: CaptainOrderState;
  };
}

export interface OrderPatch {
  readonly orderId: CaptainOrderId;
  /** The write applies only while the order is in one of these states. */
  readonly from: ReadonlyArray<CaptainOrderState>;
  readonly at: string;
  readonly state?: CaptainOrderState;
  readonly retries?: number;
  readonly verify?: CaptainVerifyResult | null;
  readonly review?: CaptainReview | null;
  readonly stallLevel?: number;
  readonly pendingFollowUp?: string | null;
  readonly releaseClaim?: boolean;
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
    /** The order's state after the write. */
    readonly recordReport: (
      input: OrderReportWrite & { readonly at: string },
    ) => Effect.Effect<CaptainOrderState, CaptainError>;
    /** True when the order was in one of `from` and the fields were written. A state change drops the claim. */
    readonly patchOrder: (input: OrderPatch) => Effect.Effect<boolean, CaptainError>;
    /** Orders in `state` that no one holds, or whose hold began before `staleBefore`. */
    readonly listUnclaimed: (input: {
      readonly state: CaptainOrderState;
      readonly staleBefore: string;
    }) => Effect.Effect<ReadonlyArray<CaptainOrder>, CaptainError>;
    readonly listInState: (
      state: CaptainOrderState,
    ) => Effect.Effect<ReadonlyArray<CaptainOrder>, CaptainError>;
    /** True when this call took the hold. */
    readonly claimWork: (input: {
      readonly orderId: CaptainOrderId;
      readonly state: CaptainOrderState;
      readonly at: string;
      readonly staleBefore: string;
    }) => Effect.Effect<boolean, CaptainError>;
    readonly releaseAllClaims: () => Effect.Effect<void, CaptainError>;
    readonly insertEscalation: (escalation: CaptainEscalation) => Effect.Effect<void, CaptainError>;
    readonly getEscalation: (
      id: CaptainEscalationId,
    ) => Effect.Effect<Option.Option<CaptainEscalation>, CaptainError>;
    readonly listEscalations: (input: {
      readonly captainId?: CaptainId | undefined;
      readonly status?: CaptainEscalationStatus | undefined;
    }) => Effect.Effect<ReadonlyArray<CaptainEscalation>, CaptainError>;
    readonly findOpenEscalation: (input: {
      readonly captainId: CaptainId;
      readonly orderId: CaptainOrderId | null;
      readonly kind: CaptainEscalationKind;
      readonly requestId: string | null;
    }) => Effect.Effect<Option.Option<CaptainEscalation>, CaptainError>;
    /** True when the item was open and is now resolved. */
    readonly resolveEscalation: (input: {
      readonly id: CaptainEscalationId;
      readonly resolution: string;
      readonly at: string;
    }) => Effect.Effect<boolean, CaptainError>;
    readonly resolveOrderEscalations: (input: {
      readonly orderId: CaptainOrderId;
      readonly kind: CaptainEscalationKind;
      readonly resolution: string;
      readonly at: string;
    }) => Effect.Effect<ReadonlyArray<CaptainEscalation>, CaptainError>;
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
    const from = input.moveTo?.from ?? [];
    const to = input.moveTo?.to ?? "";
    const rows = yield* sql<{ readonly state: string }>`
      UPDATE captain_orders
      SET last_report_json = ${encodeReport(input.report)},
          state = CASE WHEN ${from.length} > 0 AND state IN ${sql.in(from.length > 0 ? from : [""])}
                       THEN ${to} ELSE state END,
          claimed_at = CASE WHEN ${from.length} > 0 AND state IN ${sql.in(from.length > 0 ? from : [""])}
                            THEN NULL ELSE claimed_at END,
          report_md = COALESCE(${input.reportMd ?? null}, report_md),
          updated_at = ${input.at}, last_activity_at = ${input.at}
      WHERE order_id = ${input.orderId}
      RETURNING state
    `.pipe(storage);
    return (rows[0]?.state ?? "dropped") as CaptainOrderState;
  });

  const patchOrder = Effect.fn("CaptainStore.patchOrder")(function* (input: OrderPatch) {
    const flag = (present: boolean) => (present ? 1 : 0);
    const rows = yield* sql`
      UPDATE captain_orders
      SET state = CASE WHEN ${flag(input.state !== undefined)} = 1 THEN ${input.state ?? ""} ELSE state END,
          retries = CASE WHEN ${flag(input.retries !== undefined)} = 1 THEN ${input.retries ?? 0} ELSE retries END,
          verify_json = CASE WHEN ${flag(input.verify !== undefined)} = 1
                             THEN ${input.verify == null ? null : encodeVerify(input.verify)} ELSE verify_json END,
          review_json = CASE WHEN ${flag(input.review !== undefined)} = 1
                             THEN ${input.review == null ? null : encodeReview(input.review)} ELSE review_json END,
          stall_level = CASE WHEN ${flag(input.stallLevel !== undefined)} = 1 THEN ${input.stallLevel ?? 0} ELSE stall_level END,
          followup_text = CASE WHEN ${flag(input.pendingFollowUp !== undefined)} = 1 THEN ${input.pendingFollowUp ?? null} ELSE followup_text END,
          claimed_at = CASE WHEN ${flag(input.state !== undefined || input.releaseClaim === true)} = 1 THEN NULL ELSE claimed_at END,
          updated_at = ${input.at}
      WHERE order_id = ${input.orderId} AND state IN ${sql.in(input.from)}
      RETURNING order_id
    `.pipe(storage);
    return rows.length > 0;
  });

  const listUnclaimed = Effect.fn("CaptainStore.listUnclaimed")(function* (input: {
    readonly state: CaptainOrderState;
    readonly staleBefore: string;
  }) {
    const rows = yield* sql<OrderRow>`
      SELECT * FROM captain_orders
      WHERE state = ${input.state} AND (claimed_at IS NULL OR claimed_at < ${input.staleBefore})
      ORDER BY updated_at ASC, rowid ASC
    `.pipe(storage);
    return yield* Effect.forEach(rows, orderFromRow).pipe(storage);
  });

  const listInState = Effect.fn("CaptainStore.listInState")(function* (state: CaptainOrderState) {
    const rows = yield* sql<OrderRow>`
      SELECT * FROM captain_orders WHERE state = ${state} ORDER BY created_at ASC, rowid ASC
    `.pipe(storage);
    return yield* Effect.forEach(rows, orderFromRow).pipe(storage);
  });

  const claimWork = Effect.fn("CaptainStore.claimWork")(function* (input: {
    readonly orderId: CaptainOrderId;
    readonly state: CaptainOrderState;
    readonly at: string;
    readonly staleBefore: string;
  }) {
    const rows = yield* sql`
      UPDATE captain_orders SET claimed_at = ${input.at}
      WHERE order_id = ${input.orderId} AND state = ${input.state}
        AND (claimed_at IS NULL OR claimed_at < ${input.staleBefore})
      RETURNING order_id
    `.pipe(storage);
    return rows.length > 0;
  });

  const releaseAllClaims = Effect.fn("CaptainStore.releaseAllClaims")(function* () {
    yield* sql`UPDATE captain_orders SET claimed_at = NULL WHERE claimed_at IS NOT NULL`.pipe(
      storage,
    );
  });

  const insertEscalation = Effect.fn("CaptainStore.insertEscalation")(function* (
    escalation: CaptainEscalation,
  ) {
    yield* sql`
      INSERT INTO captain_escalations
        (escalation_id, captain_id, order_id, kind, summary, detail, options_json, status,
         resolution, request_id, created_at, resolved_at)
      VALUES
        (${escalation.id}, ${escalation.captainId}, ${escalation.orderId}, ${escalation.kind},
         ${escalation.summary}, ${escalation.detail}, ${encodeStringArray(escalation.options)},
         ${escalation.status}, ${escalation.resolution}, ${escalation.requestId},
         ${escalation.createdAt}, ${escalation.resolvedAt})
    `.pipe(storage);
  });

  const getEscalation = Effect.fn("CaptainStore.getEscalation")(function* (
    id: CaptainEscalationId,
  ) {
    const [row] = yield* sql<EscalationRow>`
      SELECT * FROM captain_escalations WHERE escalation_id = ${id}
    `.pipe(storage);
    return row === undefined
      ? Option.none<CaptainEscalation>()
      : Option.some(yield* escalationFromRow(row).pipe(storage));
  });

  const listEscalations = Effect.fn("CaptainStore.listEscalations")(function* (input: {
    readonly captainId?: CaptainId | undefined;
    readonly status?: CaptainEscalationStatus | undefined;
  }) {
    const rows = yield* sql<EscalationRow>`
      SELECT * FROM captain_escalations
      WHERE (${input.captainId ?? null} IS NULL OR captain_id = ${input.captainId ?? null})
        AND (${input.status ?? null} IS NULL OR status = ${input.status ?? null})
      ORDER BY created_at ASC, rowid ASC
    `.pipe(storage);
    return yield* Effect.forEach(rows, escalationFromRow).pipe(storage);
  });

  const findOpenEscalation = Effect.fn("CaptainStore.findOpenEscalation")(function* (input: {
    readonly captainId: CaptainId;
    readonly orderId: CaptainOrderId | null;
    readonly kind: CaptainEscalationKind;
    readonly requestId: string | null;
  }) {
    const [row] = yield* sql<EscalationRow>`
      SELECT * FROM captain_escalations
      WHERE captain_id = ${input.captainId} AND status = 'open' AND kind = ${input.kind}
        AND order_id IS ${input.orderId} AND request_id IS ${input.requestId}
      LIMIT 1
    `.pipe(storage);
    return row === undefined
      ? Option.none<CaptainEscalation>()
      : Option.some(yield* escalationFromRow(row).pipe(storage));
  });

  const resolveEscalation = Effect.fn("CaptainStore.resolveEscalation")(function* (input: {
    readonly id: CaptainEscalationId;
    readonly resolution: string;
    readonly at: string;
  }) {
    const rows = yield* sql`
      UPDATE captain_escalations SET status = 'resolved', resolution = ${input.resolution}, resolved_at = ${input.at}
      WHERE escalation_id = ${input.id} AND status = 'open'
      RETURNING escalation_id
    `.pipe(storage);
    return rows.length > 0;
  });

  const resolveOrderEscalations = Effect.fn("CaptainStore.resolveOrderEscalations")(
    function* (input: {
      readonly orderId: CaptainOrderId;
      readonly kind: CaptainEscalationKind;
      readonly resolution: string;
      readonly at: string;
    }) {
      const rows = yield* sql<EscalationRow>`
        UPDATE captain_escalations SET status = 'resolved', resolution = ${input.resolution}, resolved_at = ${input.at}
        WHERE order_id = ${input.orderId} AND kind = ${input.kind} AND status = 'open'
        RETURNING *
      `.pipe(storage);
      return yield* Effect.forEach(rows, escalationFromRow).pipe(storage);
    },
  );

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
    patchOrder,
    listUnclaimed,
    listInState,
    claimWork,
    releaseAllClaims,
    insertEscalation,
    getEscalation,
    listEscalations,
    findOpenEscalation,
    resolveEscalation,
    resolveOrderEscalations,
    touchActivity,
  });
});

export const layer = Layer.effect(CaptainStore, make);
