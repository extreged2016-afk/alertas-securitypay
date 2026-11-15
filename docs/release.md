# Releasing securitypay

Pushing a tag `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml).
It builds everything first and publishes only once every build has succeeded:

| Artifact | Where it goes |
|---|---|
| Android APK signed with the release key (`securitypay-X.Y.Z.apk`) | GitHub release |
| Daemon sdist + wheel (`securitypay` on PyPI) | PyPI (trusted publishing) and the GitHub release |
| `ghcr.io/<owner>/securitypay-relay:X.Y.Z` and `securitypay-daemon:X.Y.Z` (amd64 + arm64, SBOM + provenance) | GitHub Container Registry; `latest` too for final releases |
| `SHA256SUMS` of every file in the release | GitHub release |

Pre-releases use PEP 440 suffixes: `v0.3.0a1`, `v0.3.0b2`, `v0.3.0rc1`. They are
marked as pre-releases on GitHub, don't move the `latest` image tag, and pip only
installs them when asked for explicitly. Other tag shapes (`v0.3`, `v0.3.0-rc.1`)
are rejected.

The Android `versionCode` is derived from the tag so that every release upgrades
the previous one: `major·1000000 + minor·10000 + patch·100 + slot`, where the slot
is `N` for `aN`, `30+N` for `bN`, `60+N` for `rcN` and `99` for the final release
(`v0.2.0rc1` → 20061, `v0.2.0` → 20099).

## One-time setup

### 1. Release signing key

The key that signs the APK can **never change**: Android refuses to update an app
signed with a different key, so losing it means every user has to uninstall and
reinstall. Generate it once, on your own machine, and keep an offline backup of the
file and its password (e.g. in a password manager).

```bash
keytool -genkeypair -v -keystore securitypay-release.jks -storetype PKCS12 \
  -alias securitypay -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=securitypay"
```

`keytool` ships with any JDK (`$JAVA_HOME/bin/keytool`). It asks for a password; a
PKCS12 keystore uses the same one for the key.

Note the certificate's SHA-256 fingerprint (lowercase, no colons, the way `apksigner`
prints it) for the optional check in step 2:

```bash
keytool -list -v -keystore securitypay-release.jks -alias securitypay \
  | sed -n 's/.*SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f'
```

APKs signed with this key don't install over the debug-signed builds of the
`android-preview` pre-release (same package name, different key). Testers coming
from those need to uninstall first.

### 2. GitHub secrets and variables

Repository → Settings → Secrets and variables → Actions:

| Name | Kind | Value |
|---|---|---|
| `SECURITYPAY_KEYSTORE_BASE64` | secret | the keystore, base64 on one line |
| `SECURITYPAY_KEYSTORE_PASSWORD` | secret | keystore password |
| `SECURITYPAY_KEY_ALIAS` | secret | `securitypay` (the `-alias` above) |
| `SECURITYPAY_KEY_PASSWORD` | secret | key password; optional for PKCS12 (defaults to the keystore password) |
| `SECURITYPAY_RELEASE_CERT_SHA256` | variable (optional) | the fingerprint from step 1; when set, an APK signed by anything else fails the release |

With the GitHub CLI:

```bash
base64 < securitypay-release.jks | tr -d '\n' | gh secret set SECURITYPAY_KEYSTORE_BASE64
gh secret set SECURITYPAY_KEYSTORE_PASSWORD      # prompts for the value
gh secret set SECURITYPAY_KEY_ALIAS --body securitypay
gh secret set SECURITYPAY_KEY_PASSWORD
gh variable set SECURITYPAY_RELEASE_CERT_SHA256 --body <fingerprint>
```

The workflow decodes the keystore into the runner's temporary directory, sets
`SECURITYPAY_REQUIRE_RELEASE_KEY=1` (so a missing key fails the build instead of
falling back to the debug key), deletes the file right after the build and checks
that the APK is not signed with the debug certificate.

### 3. PyPI trusted publishing

No PyPI token is stored anywhere: PyPI trusts this repository's workflow through
OpenID Connect.

The `pypi` job only runs when the repository variable `SECURITYPAY_PUBLISH_PYPI` is `true`
(`gh variable set SECURITYPAY_PUBLISH_PYPI --body true`). Until then a release skips PyPI,
attaches the wheel to the GitHub release and its notes say how to install from it.

1. On [pypi.org](https://pypi.org) → your account → **Publishing** → *Add a new
   pending publisher* (the project doesn't exist yet; once it does, use the project's
   own Publishing page):
   - PyPI project name: `securitypay`
   - Owner: `mutonby`, repository: `securitypay`
   - Workflow name: `release.yml`
   - Environment name: `pypi`
2. On GitHub → Settings → Environments → **New environment** `pypi`. Recommended:
   *Required reviewers* (yourself), so every upload waits for a click, and
   *Deployment branches and tags* → selected tags → `v*`.

PyPI versions are immutable: a version that was uploaded can never be uploaded
again, even after deleting it. A broken release is fixed with a new version.

Publishing to PyPI makes the daemon's source (the sdist) public even while this
repository is private.

### 4. GitHub Container Registry

Nothing to create: the `images` job pushes with the workflow's own `GITHUB_TOKEN`
(`packages: write` is granted to that job only). The first push creates the
packages `securitypay-relay` and `securitypay-daemon` under the owner's account,
linked to this repository through the `org.opencontainers.image.source` label.

New packages of a private repository are private. To let anyone pull them: the
package's page → Package settings → **Change visibility** → Public.

If the organisation or repository restricts workflow permissions (Settings →
Actions → General → Workflow permissions), it must still allow jobs to request
`packages: write`, `contents: write` and `id-token: write`.

### 5. Optional: protect release tags

Settings → Rules → Rulesets → New tag ruleset, target `v*`, restrict creations,
updates and deletions to maintainers. Anyone who can push a `v*` tag can publish a
release.

## Cutting a release

1. Pick a commit on the default branch whose CI is green.
2. Set the version everywhere it is written down (the workflow refuses a tag that
   doesn't match `daemon/pyproject.toml`, and checks the wheel's
   `securitypay.__version__`):

   ```bash
   # daemon/pyproject.toml: version = "0.2.0", then refresh the lockfile:
   cd daemon && uv lock && cd ..
   ```

   Also bump `relay/package.json` and the relay's `VERSION` constant
   (`relay/src/routes/system.ts`), which `/v1/status` reports.
   Commit (`release: 0.2.0`) and push; wait for CI.
3. Tag and push the tag:

   ```bash
   git tag -a v0.2.0 -m "securitypay 0.2.0"
   git push origin v0.2.0
   ```

4. Follow the run in the Actions tab; approve the `pypi` environment when asked.
5. Afterwards, set the next development version (e.g. `0.3.0.dev0` in
   `daemon/pyproject.toml`, `uv lock`) so later builds don't claim to be the release.

If the run fails before the `pypi` job, fix the problem, delete the tag
(`git push --delete origin v0.2.0 && git tag -d v0.2.0`) and tag again. After PyPI
has the version, release a new patch version instead.

## Building a release APK locally

```bash
cd app-android
export SECURITYPAY_KEYSTORE_FILE=/path/to/securitypay-release.jks
export SECURITYPAY_KEYSTORE_PASSWORD=… SECURITYPAY_KEY_ALIAS=securitypay
./gradlew :app:assembleRelease -PversionName=0.2.0 -PversionCode=20099
```

The same names also work as Gradle properties (`-PSECURITYPAY_KEYSTORE_FILE=…`).
Without `SECURITYPAY_KEYSTORE_FILE`, `assembleRelease` still works but signs with the
public debug key and prints a warning: fine for testing, never publish that APK.
Without `-PversionName`/`-PversionCode` the build is `0.2.0-dev` / `1`.

## Google Play

Play takes an Android App Bundle (AAB), not an APK. Build it with the release key, which
then acts as Play's *upload key* (enrol in Play App Signing when creating the app):

```bash
cd app-android
export SECURITYPAY_KEYSTORE_FILE=/path/to/securitypay-release.jks
export SECURITYPAY_KEYSTORE_PASSWORD=… SECURITYPAY_KEY_ALIAS=… SECURITYPAY_KEY_PASSWORD=…
SECURITYPAY_REQUIRE_RELEASE_KEY=1 ./gradlew :app:bundleRelease -PversionName=0.3.0 -PversionCode=30099
# -> app/build/outputs/bundle/release/app-release.aab
```

`versionCode` must grow with every upload. The app targets API 36, which Play requires
for new apps and updates from 2026-08-31.

**Android Auto stays out of production bundles.** Google Play takes calling apps for cars
only on its internal and closed testing tracks and rejects a production or open-testing
release that contains one, so `bundleRelease` leaves the car entry point out by default.
For a closed-testing track with Android Auto, build a separate bundle with
`-PsecuritypayAndroidAuto=true` and a higher `versionCode`, and never promote it to
production ([android-auto.md](android-auto.md)). The GitHub APK always includes it.

Play Console items this app needs:

- **Privacy policy:** `https://securitypay.io/privacy`. **Account deletion:**
  `https://securitypay.io/delete-account` (accounts exist only on securitypay cloud; they are
  deleted from the dashboard or by email). Self-hosted users have no account.
- **Full-screen intent** (`USE_FULL_SCREEN_INTENT`): declare "calling app" — incoming calls
  show over the lock screen.
- **Foreground service types** `phoneCall` and `microphone`: declare them with a short video
  of an incoming call being answered (an agent calls, the phone rings locked, the call runs).
- **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`:** restricted on Play. Justify it as a calling
  app whose calls must ring in Doze; if review rejects it, a Play build can drop the
  permission and open `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` instead.
- **Data safety:** microphone audio during calls (sent to the user's relay / voice AI,
  not stored by the app), messages, device identifiers and the FCM token; data in transit
  is encrypted (https/wss); the user can delete it (unpair, or delete the cloud account).
- New personal developer accounts must run a closed test (12+ testers, 14 days) before
  production; organisation accounts don't.

## Directories

Where securitypay is listed, and what to refresh after a release:

- **MCP Registry** (`registry.modelcontextprotocol.io`, feeds GitHub's registry and other
  directories): [`server.json`](../server.json) lists the hosted server
  (`https://securitypay.io/mcp`) as `io.github.mutonby/securitypay`. Set its `version` to the
  release, then `mcp-publisher validate`, `mcp-publisher login github` and
  `mcp-publisher publish` from the repository root. A version can be published once.
- **Grok Build plugin marketplace** (`xai-org/plugin-marketplace`):
  [`plugins/securitypay`](../plugins/securitypay) is the plugin (the hosted MCP server and a
  copy of the skill; a test keeps the copy equal). The catalog entry pins a commit of this
  repository, so after changing the plugin or the skill, open a PR there that bumps the
  `sha` and regenerates the index (its CONTRIBUTING.md has the commands).
- **skills.sh**: nothing to publish. It lists `skills/securitypay` from this repository as
  people install it (`npx skills add mutonby/securitypay`).
- **Glama** (`glama.ai/mcp/servers/mutonby/securitypay`): it builds the server from this
  repository with the settings on its admin page (build step `uv sync --project daemon
  --frozen --no-dev`, command `uv run --project daemon --no-sync securitypay mcp`, Python
  3.12, placeholder relay URL and API key) and checks that it starts and lists its tools.
  Auto-release is on: it rebuilds on every GitHub release.
- **awesome-mcp-servers** (`punkpeye/awesome-mcp-servers`, Communication): one line in
  its README; only needs a PR if the description changes.
- **ClawHub**: `clawhub skill publish skills/securitypay --slug securitypay --version <x.y.z>`
  after changing the skill.
