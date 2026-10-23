const defaultServerBaseUrl = "http://localhost:3001";
/** Build-time marker for the containerised same-origin deployment (OP-07). */
const sameOriginSentinel = "same-origin";

export function getServerBaseUrl() {
  // Must access process.env.NEXT_PUBLIC_* directly — webpack DefinePlugin
  // only replaces direct references, not indirect access via a variable.
  const configuredUrl = process.env.NEXT_PUBLIC_SERVER_BASE_URL?.trim();
  if (configuredUrl === sameOriginSentinel) {
    // deploy/nginx.conf proxies /api and /objects on the serving host, so the
    // API base is an empty string and every request stays a relative URL.
    return "";
  }
  return configuredUrl || defaultServerBaseUrl;
}

export type WebEnv = {
  serverBaseUrl: string;
  supabaseAnonKey: string;
  supabaseUrl: string;
};

export function loadWebEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    serverBaseUrl: overrides.serverBaseUrl ?? getServerBaseUrl(),
    supabaseUrl:
      overrides.supabaseUrl ??
      requireEnv(
        "NEXT_PUBLIC_SUPABASE_URL",
        process.env.NEXT_PUBLIC_SUPABASE_URL,
      ),
    supabaseAnonKey:
      overrides.supabaseAnonKey ??
      requireEnv(
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      ),
  };
}

function requireEnv(name: string, value: string | undefined) {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    throw new Error(`Missing required browser env: ${name}`);
  }

  return normalizedValue;
}
