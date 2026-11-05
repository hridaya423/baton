import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ThreadRoles from "../orchestration-v2/ThreadRoles.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CaptainService from "./CaptainService.ts";
import { captainThreadId, environmentId, makeHarness, shell } from "./Captain.testkit.ts";

const ordinaryThreadId = ThreadId.make("thread:ordinary");
const instanceId = ProviderInstanceId.make("codex");

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId,
  requestNamespace: threadId,
  thread: { threadId, providerSessionId: threadId, providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "captain-tools-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "captain-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const orderInput = {
  title: "readme",
  brief: "Juice up the README.",
  kind: "change",
  touches: ["README.md"],
};

it.effect(
  "shows captain tools to a captain, crew_report to its crew and nothing to other threads",
  () => {
    const harness = makeHarness();
    harness.shells.set(ordinaryThreadId, shell(ordinaryThreadId));
    return Effect.scoped(
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* captains.create({ threadId: captainThreadId });
        const { order } = yield* captains.createOrder({
          captain,
          order: { ...orderInput, kind: "change" },
          runtimeModeCeiling: "full-access",
        });
        const crewThreadId = order.threadId!;
        const reviewerThreadId = ThreadId.make("thread:reviewer");
        yield* (yield* ThreadRoles.ThreadRoles).set(reviewerThreadId, {
          role: "reviewer",
          captainId: captain.id,
          orderId: order.id,
          instructions: "review",
        });
        const services =
          yield* Effect.context<
            Exclude<
              Layer.Services<typeof McpHttpServer.layerCaptainToolkit>,
              McpServer.McpRequest<"Requires", McpInvocationContext.McpInvocationContext>
            >
          >();
        const scopes = new Map(
          [captainThreadId, crewThreadId, ordinaryThreadId, reviewerThreadId].map(
            (id) => [id, scopeFor(id)] as const,
          ),
        );
        const serverLayer = McpHttpServer.layerMcpTransport(McpHttpServer.layerCaptainToolkit).pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) => Effect.succeed(scopes.get(ThreadId.make(token))),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.succeedContext(services)),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const session = Effect.fn("captainTools.session")(function* (token: string) {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const rpc = (method: string, params: object) =>
            httpClient
              .post("/mcp", {
                headers: {
                  ...headers,
                  "mcp-session-id": initialize.headers["mcp-session-id"]!,
                  "mcp-protocol-version": "2025-06-18",
                },
                body: HttpBody.text(
                  JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                  "application/json",
                ),
              })
              .pipe(Effect.flatMap((response) => response.json));
          const listed = rpc("tools/list", {}).pipe(
            Effect.map((body) =>
              (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools
                .map((tool) => tool.name)
                .toSorted(),
            ),
          );
          return { rpc, listed };
        });

        const captainSession = yield* session(captainThreadId);
        const crewSession = yield* session(crewThreadId);
        const ordinarySession = yield* session(ordinaryThreadId);
        const reviewerSession = yield* session(reviewerThreadId);

        assert.deepEqual(yield* captainSession.listed, [
          "escalate",
          "order_answer",
          "order_create",
          "order_drop",
          "order_list",
          "order_read",
          "order_retry",
          "order_send",
        ]);
        assert.deepEqual(yield* crewSession.listed, ["crew_report"]);
        assert.deepEqual(yield* reviewerSession.listed, ["review_submit"]);
        assert.deepEqual(yield* ordinarySession.listed, []);

        const refused = (body: unknown) => JSON.stringify(body).toLowerCase();
        const ordinaryCall = yield* ordinarySession.rpc("tools/call", {
          name: "order_list",
          arguments: {},
        });
        assert.include(refused(ordinaryCall), "not found");
        const crewCall = yield* crewSession.rpc("tools/call", {
          name: "order_create",
          arguments: orderInput,
        });
        assert.include(refused(crewCall), "not found");
        const captainCall = yield* captainSession.rpc("tools/call", {
          name: "crew_report",
          arguments: { status: "done", summary: "x" },
        });
        assert.include(refused(captainCall), "not found");
        assert.equal((yield* captains.listOrders(captain)).length, 1);

        const listCall = (yield* captainSession.rpc("tools/call", {
          name: "order_list",
          arguments: {},
        })) as { result: { structuredContent: { counts: { running: number } } } };
        assert.equal(listCall.result.structuredContent.counts.running, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(harness.layer, NodeHttpServer.layerTest)));
  },
);

it.effect("refuses a caller whose scope claims a role the database does not give it", () => {
  const harness = makeHarness();
  harness.shells.set(ordinaryThreadId, shell(ordinaryThreadId));
  const layer = McpHttpServer.layerCaptainToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(harness.layer),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const captains = yield* CaptainService.CaptainService;
    const captain = yield* captains.create({ threadId: captainThreadId });
    const call = (
      name: string,
      args: Record<string, unknown>,
      threadId: ThreadId,
      role: "captain" | "crew",
    ) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scopeFor(threadId),
          thread: { ...scopeFor(threadId).thread, role },
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    const spoofedCaptain = yield* call("order_create", orderInput, ordinaryThreadId, "captain");
    assert.isTrue(spoofedCaptain.isError);
    assert.include(
      JSON.stringify(spoofedCaptain.content),
      "Only a captain thread can use this tool.",
    );
    const spoofedCrew = yield* call(
      "crew_report",
      { status: "done", summary: "x" },
      ordinaryThreadId,
      "crew",
    );
    assert.isTrue(spoofedCrew.isError);
    assert.deepEqual(yield* captains.listOrders(captain), []);

    yield* captains.release(captain.id);
    const released = yield* call("order_create", orderInput, captainThreadId, "captain");
    assert.isTrue(released.isError);
    assert.deepEqual(yield* captains.listOrders(captain), []);
  }).pipe(Effect.provide(layer));
});
