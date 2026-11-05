import type { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

export interface ReviewerCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: "ready" | "warning" | "error" | "disabled";
  readonly auth: { readonly status: "authenticated" | "unauthenticated" | "unknown" };
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isLegacy?: boolean | undefined;
  }>;
}

export interface ReviewerChoice {
  readonly model: ModelSelection;
  readonly sameProvider: boolean;
}

const WEAK = /(mini|nano|haiku|flash|lite|spark|preview|legacy)/;
const STRONG = /(opus|pro|max|ultra)/;

/** Higher is stronger: the newest version first, then the tier the name claims. */
export const modelStrength = (slug: string): number => {
  const name = slug.toLowerCase();
  const version = /(\d+)(?:[.-](\d+))?/.exec(name);
  const major = version === null ? 0 : Number(version[1]);
  const minor = version?.[2] === undefined ? 0 : Math.min(Number(version[2]), 99);
  const tier = WEAK.test(name) ? 0 : STRONG.test(name) ? 2 : 1;
  return (major * 100 + minor) * 10 + tier;
};

const strongestModel = (
  models: ReadonlyArray<{ readonly slug: string; readonly isLegacy?: boolean | undefined }>,
  exclude?: string,
): string | undefined =>
  models
    .filter((model) => model.isLegacy !== true && model.slug !== exclude)
    .toSorted((left, right) => modelStrength(right.slug) - modelStrength(left.slug))[0]?.slug;

const usable = (candidate: ReviewerCandidate) =>
  candidate.enabled &&
  candidate.installed &&
  candidate.status !== "error" &&
  candidate.status !== "disabled" &&
  candidate.auth.status !== "unauthenticated";

/** The driver a crew on `driver` is reviewed by first: Claude by Codex, everything else by Claude. */
const OTHER_DRIVER_ORDER: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["codex"],
  codex: ["claudeAgent"],
};
const DEFAULT_OTHER_ORDER = ["claudeAgent", "codex"];

export const pickReviewer = (input: {
  readonly crew: ModelSelection;
  readonly crewDriver: ProviderDriverKind;
  readonly configured: ModelSelection | undefined;
  readonly providers: ReadonlyArray<ReviewerCandidate>;
}): ReviewerChoice => {
  const driverOf = (instanceId: ProviderInstanceId) =>
    input.providers.find((provider) => provider.instanceId === instanceId)?.driver;
  if (input.configured !== undefined) {
    return {
      model: input.configured,
      sameProvider:
        (driverOf(input.configured.instanceId) ?? input.crewDriver) === input.crewDriver,
    };
  }
  const order = OTHER_DRIVER_ORDER[input.crewDriver] ?? DEFAULT_OTHER_ORDER;
  for (const driver of order) {
    for (const provider of input.providers) {
      if (provider.driver !== driver || !usable(provider)) continue;
      const slug = strongestModel(provider.models);
      if (slug !== undefined) {
        return { model: { instanceId: provider.instanceId, model: slug }, sameProvider: false };
      }
    }
  }
  const own = input.providers.find((provider) => provider.instanceId === input.crew.instanceId);
  const other = own === undefined ? undefined : strongestModel(own.models, input.crew.model);
  return {
    model: other === undefined ? input.crew : { instanceId: input.crew.instanceId, model: other },
    sameProvider: true,
  };
};
