import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FcmClientConfig {
  project_id: string;
  application_id: string;
  api_key: string;
  sender_id: string;
}

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  agentName: string;
  /** Explicit API key from env; otherwise one is generated and persisted. */
  apiKey?: string;
  /** Optional human-friendly password for the web panel (PANEL_PASSWORD or SECURITYPAY_PANEL_PASSWORD). */
  panelPassword?: string;
  ringTimeoutS: number;
  /** Reverse proxies in front of the relay; the client address is read that many hops from the right of X-Forwarded-For. */
  trustedProxies?: number;
  insecureDev: boolean;
  livekit?: LiveKitConfig;
  fcm?: {
    serviceAccountFile: string;
    client: FcmClientConfig;
    /** Overridable for tests. */
    apiBase: string;
  };
}

export interface LiveKitConfig {
  /** URL handed to clients (phone and daemon) to join rooms, e.g. wss://relay.example.com. */
  publicUrl: string;
  /** URL the relay uses for LiveKit's server API (room service). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export const ANDROID_PACKAGE = "com.securitypay.alerts";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function trimmedEnv(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Cleans an identifier/token env var pasted into dashboards like Render:
 * strips accidental leading/trailing whitespace and matching wrapping quotes.
 */
function cleanTokenEnv(name: string): string | undefined {
  let v = process.env[name]?.trim();
  if (!v) return undefined;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v === "" ? undefined : v;
}

/**
 * Secrets on Render/Heroku are environment variables, not mounted files. Accept
 * raw JSON or base64-encoded JSON (base64 survives newlines in a private key).
 */
function jsonEnv(name: string): string | undefined {
  const raw = env(name)?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("{")) return raw;
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

function persistSecret(dataDir: string, filename: string, contents: string): string {
  if (dataDir === ":memory:") return filename;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, filename);
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

/**
 * Extracts the public Firebase client values for our Android package from a
 * google-services.json downloaded from the Firebase console.
 */
export function parseGoogleServices(json: unknown, pkg = ANDROID_PACKAGE): FcmClientConfig {
  const j = json as {
    project_info?: { project_id?: string; project_number?: string };
    client?: Array<{
      client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } };
      api_key?: Array<{ current_key?: string }>;
    }>;
  };
  const client = j.client?.find((c) => c.client_info?.android_client_info?.package_name === pkg);
  if (!client) {
    throw new Error(`google-services.json has no Android app with package name "${pkg}"`);
  }
  const out = {
    project_id: j.project_info?.project_id ?? "",
    sender_id: j.project_info?.project_number ?? "",
    application_id: client.client_info?.mobilesdk_app_id ?? "",
    api_key: client.api_key?.[0]?.current_key ?? "",
  };
  for (const [k, v] of Object.entries(out)) {
    if (!v) throw new Error(`google-services.json is missing ${k}`);
  }
  return out;
}

/** Fastify's `trustProxy`: trust exactly that many hops, nearest first. */
export function trustedHops(cfg: Pick<Config, "trustedProxies">): (address: string, hop: number) => boolean {
  const hops = cfg.trustedProxies ?? 1;
  return (_address, hop) => hop < hops;
}

function trustedProxies(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`SECURITYPAY_TRUSTED_PROXIES must be a number of proxies (got ${value})`);
  return Number(value);
}

export function loadConfig(): Config {
  const dataDir = trimmedEnv("SECURITYPAY_DATA_DIR", "./data")!;
  const port = Number(trimmedEnv("PORT", "8080"));
  // Render sets RENDER_EXTERNAL_URL automatically, so a fresh deploy works without
  // copying the hostname by hand; SECURITYPAY_PUBLIC_URL always wins.
  const publicUrl = trimmedEnv("SECURITYPAY_PUBLIC_URL", trimmedEnv("RENDER_EXTERNAL_URL", `http://localhost:${port}`))!.replace(
    /\/+$/,
    "",
  );
  const insecureDev = trimmedEnv("SECURITYPAY_INSECURE_DEV") === "1";
  if (!publicUrl.startsWith("https://") && !insecureDev) {
    throw new Error(
      `SECURITYPAY_PUBLIC_URL must be https:// (got ${publicUrl}). Set SECURITYPAY_INSECURE_DEV=1 for local development only.`,
    );
  }

  let fcm: Config["fcm"];
  let saFile = trimmedEnv("FCM_SERVICE_ACCOUNT_FILE");
  const gsFile = trimmedEnv("FCM_GOOGLE_SERVICES_FILE");
  const saJson = jsonEnv("FCM_SERVICE_ACCOUNT_JSON");
  const gsJson = jsonEnv("FCM_GOOGLE_SERVICES_JSON") ?? (gsFile ? readFileSync(gsFile, "utf8") : undefined);
  if (saJson && !saFile) saFile = persistSecret(dataDir, "firebase-service-account.json", saJson);
  if (saFile || gsJson) {
    if (!saFile || !gsJson) {
      throw new Error(
        "FCM needs a service account and a client config: FCM_SERVICE_ACCOUNT_FILE/JSON and FCM_GOOGLE_SERVICES_FILE/JSON",
      );
    }
    fcm = {
      serviceAccountFile: saFile,
      client: parseGoogleServices(JSON.parse(gsJson)),
      apiBase: trimmedEnv("FCM_API_BASE", "https://fcm.googleapis.com")!,
    };
  }

  let livekit: LiveKitConfig | undefined;
  const lkKey = trimmedEnv("LIVEKIT_API_KEY");
  // Prefer a file (mounted read-only) so the secret never sits in the environment,
  // where `docker inspect` and deploy tooling would show it.
  const lkSecretFile = trimmedEnv("LIVEKIT_API_SECRET_FILE");
  const lkSecret = lkSecretFile ? readFileSync(lkSecretFile, "utf8").trim() : trimmedEnv("LIVEKIT_API_SECRET");
  if (lkKey || lkSecret) {
    if (!lkKey || !lkSecret) throw new Error("Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET (or LIVEKIT_API_SECRET_FILE) to enable calls");
    // Anyone holding the secret can mint tokens for any call room.
    if (lkSecret.length < 32) throw new Error("LIVEKIT_API_SECRET must be at least 32 characters (generate one with: openssl rand -base64 32)");
    // By default LiveKit is served on the relay's own hostname (Caddy routes /rtc to it).
    const lkPublic = trimmedEnv("LIVEKIT_URL", publicUrl.replace(/^http/, "ws"))!.replace(/\/+$/, "");
    livekit = {
      publicUrl: lkPublic,
      apiUrl: trimmedEnv("LIVEKIT_API_URL", lkPublic.replace(/^ws/, "http"))!.replace(/\/+$/, ""),
      apiKey: lkKey,
      apiSecret: lkSecret,
    };
  }

  return {
    host: trimmedEnv("HOST", "0.0.0.0")!,
    port,
    publicUrl,
    dataDir,
    agentName: trimmedEnv("SECURITYPAY_AGENT_NAME", "Agent")!,
    apiKey: cleanTokenEnv("SECURITYPAY_API_KEY"),
    panelPassword: trimmedEnv("PANEL_PASSWORD") ?? trimmedEnv("SECURITYPAY_PANEL_PASSWORD"),
    ringTimeoutS: Number(trimmedEnv("SECURITYPAY_RING_TIMEOUT_S", "30")),
    trustedProxies: trustedProxies(trimmedEnv("SECURITYPAY_TRUSTED_PROXIES", "1")!),
    insecureDev,
    fcm,
    livekit,
  };
}

export function dbPath(cfg: Config): string {
  return cfg.dataDir === ":memory:" ? ":memory:" : join(cfg.dataDir, "relay.db");
}
