# Upstream

Baton is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). `main` is Baton; `upstream` is fetched by hand, about weekly.

## Pulling upstream

```sh
git fetch upstream
git rebase upstream/main
```

Each adopted upstream PR lands as one commit titled `adopt #NNNNN: <title>` and gets a row below.

## Adopted PRs

| PR  | Title | Commit |
| --- | ----- | ------ |

## Where Baton differs

Baton renames only what a user sees. Package names, env vars (`T3CODE_*`), internal identifiers and the `t3code://` link scheme stay upstream's, so rebases stay clean.

- **Name in the UI.** `scripts/lib/baton-brand.ts` rewrites "T3 Code" to "Baton" in web and desktop bundles at build time. Tests run against upstream text.
- **Identity.** Bundle id `dev.hridaya.baton`, product name "Baton", Electron profile `~/Library/Application Support/baton`, staged package name `baton`. The package name also names the macOS keychain item (`baton Safe Storage`), so Baton never reads T3 Code's key.
- **Data and ports.** State lives in `~/.baton`; the desktop backend starts at port 3873 and the CLI default is 3873. Baton runs beside T3 Code.
- **Icon.** The baton mark in `assets/{prod,dev}/app-icon.icon/Assets/text.svg`, also drawn by `apps/web/src/components/T3Wordmark.tsx`.
- **Telemetry** is off by default, since the default sink is upstream's. Set `T3CODE_TELEMETRY_ENABLED=true` to turn it on.
- **Updates.** Local builds have no update feed, so the updater never replaces Baton with T3 Code.

Windows and Linux keep upstream's AppUserModelID and desktop entry id.
