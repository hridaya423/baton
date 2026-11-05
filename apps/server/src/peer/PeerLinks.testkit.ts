import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  type AuthMcpClientAccess,
  type ExecutionEnvironmentDescriptor,
  mcpClientScopes,
  type TailnetSignInRefusedReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Agent, fetch as undiciFetch } from "undici";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TailnetSignIn from "../auth/TailnetSignIn.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

class PeerTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

type TailnetAnswer = Effect.Effect<
  TailnetSignIn.PeerLinkAuthorization,
  TailnetSignIn.TailnetSignInRefusedError
>;

const refusing = (reason: TailnetSignInRefusedReason): TailnetAnswer =>
  Effect.fail(new TailnetSignIn.TailnetSignInRefusedError({ reason }));

export const descriptorOf = (
  environmentId: string,
  label: string,
  capabilities: Partial<ExecutionEnvironmentDescriptor["capabilities"]> = {},
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    mcpModeLimitHeader: true,
    linkFence: true,
    ...capabilities,
  },
});

/**
 * The environment a link points at, as it runs: its descriptor, MCP OAuth,
 * and `/mcp` with `tools` behind the real client authenticator, on a real
 * socket. The descriptor can be swapped, as when its address comes to answer
 * as another environment, and every bearer it receives is recorded.
 */
export const servePeer = <E, R>(
  initial: ExecutionEnvironmentDescriptor,
  tools: Layer.Layer<never, E, R>,
) =>
  Effect.gen(function* () {
    const descriptor = yield* Ref.make(initial);
    const bearers = yield* Ref.make<ReadonlyArray<string>>([]);
    const probes = yield* Ref.make(0);
    const tailnet = yield* Ref.make<TailnetAnswer>(refusing("disabled"));
    const layerTailnetSignIn = Layer.mock(TailnetSignIn.TailnetSignIn)({
      authorizePeerLink: () => Effect.flatten(Ref.get(tailnet)),
    });
    const layerEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Ref.get(descriptor).pipe(Effect.map((current) => current.environmentId)),
      getDescriptor: Ref.get(descriptor),
    });
    const authContext = yield* EnvironmentAuth.layer.pipe(
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provideMerge(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-peer-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.fresh,
      Layer.build,
    );
    const layerRecordBearers = HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/.well-known/t3/environment")) {
            yield* Ref.update(probes, (count) => count + 1);
          }
          const authorization = request.headers.authorization;
          if (authorization !== undefined) {
            yield* Ref.update(bearers, (seen) => [...seen, authorization]);
          }
          return yield* httpEffect;
        }),
      { global: true },
    );
    const layerRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(PeerTestApi).pipe(
        Layer.provide(
          McpOAuthHttp.layer.pipe(
            Layer.provide(McpOAuth.layer.pipe(Layer.provide(layerTailnetSignIn))),
          ),
        ),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      McpHttpServer.layerMcpTransport(tools).pipe(
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.undefined,
          }),
        ),
        Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      ),
    ).pipe(
      Layer.provide(layerRecordBearers),
      Layer.provide(layerEnvironment),
      Layer.provide(Layer.succeedContext(authContext)),
    );
    // Fresh, so the peer never shares a toolkit or MCP server with the
    // environment that links to it in the same test.
    yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
    );
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
    return {
      url,
      /** This peer by a tailnet name, which `layerLinkingEnvironment` carries to it. */
      tailnetUrl: `http://peer-${address.port}.example.ts.net:${address.port}`,
      /** Its Tailscale check of whoever links: what they may hold, or why not. */
      tailnet,
      auth,
      /** Its settings, as for turning its Linked environments beta off. */
      settings: Context.get(authContext, ServerSettings.ServerSettingsService),
      descriptor,
      bearers,
      /** How often its descriptor was asked for, as a probe of whether it answers. */
      probes,
      /** The sessions linking created there, which its Connections lists. */
      linkedSessions: auth
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.client.label?.startsWith("T3 Code · ")),
          ),
        ),
    };
  });

export type ServedPeer = Effect.Success<ReturnType<typeof servePeer>>;

const loopbackAgent = new Agent({
  connect: {
    lookup: (_hostname, options, callback) =>
      options.all === true
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4),
  },
});

/** Resolves a `*.ts.net` name to loopback, where `servePeer` listens, so it is still reached under that name. */
const layerTailnetNamesOnLoopback = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
      const url = URL.parse(input instanceof Request ? input.url : input.toString());
      if (url === null || !url.hostname.endsWith(".ts.net")) {
        // @effect-diagnostics-next-line globalFetch:off -- This is the fetch FetchHttpClient calls.
        return globalThis.fetch(input, init);
      }
      return undiciFetch(url, {
        ...init,
        dispatcher: loopbackAgent,
      } as Parameters<typeof undiciFetch>[1]);
    }),
  ),
);

/**
 * The environment that links: its own database and secret store, reaching
 * peers over plain HTTP. Provide it to anything built on its links.
 */
export const layerLinkingEnvironment = <E = never>(
  descriptor: ExecutionEnvironmentDescriptor,
  secrets: typeof ServerSecretStore.layer = ServerSecretStore.layer,
  database: Layer.Layer<
    SqlClient.SqlClient,
    E | Layer.Error<typeof Sqlite.layerMemory>
  > = Sqlite.layerMemory,
) =>
  PeerMcpClient.layer.pipe(
    Layer.provideMerge(PeerLinks.layer),
    Layer.provideMerge(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
    Layer.provideMerge(database),
    Layer.provide(Layer.mergeAll(secrets, layerTailnetNamesOnLoopback)),
    // Services that act for this environment, such as delegation, name it too.
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(descriptor.environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-here-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

/** Lets whoever links to `peer` over its tailnet name hold up to `access`. */
export const allowTailnetLinks = (peer: ServedPeer, access: AuthMcpClientAccess = "full-access") =>
  Ref.set(peer.tailnet, Effect.succeed({ scopes: mcpClientScopes(access), via: "owner" as const }));

/** Has `peer` refuse tailnet links for `reason`, as it does until they are allowed. */
export const refuseTailnetLinks = (peer: ServedPeer, reason: TailnetSignInRefusedReason) =>
  Ref.set(peer.tailnet, refusing(reason));

/** Links `links` to `peer` with a fresh pairing code from it. */
export const linkTo = (
  links: PeerLinks.PeerLinks["Service"],
  peer: ServedPeer,
  access: AuthMcpClientAccess = "auto",
) =>
  peer.auth
    .issuePairingCredential()
    .pipe(
      Effect.flatMap((pairing) =>
        links.link({ url: peer.url, pairingCode: pairing.credential, access }),
      ),
    );
