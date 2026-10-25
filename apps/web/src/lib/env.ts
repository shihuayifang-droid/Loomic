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
  // Must access process.env.NEXT_PUBLIC_* directly — webpack DefinePlugin
  // only replaces direct references, not indirect access via a variable.
  // Importing authProvider() from self-auth-client here would turn this into
  // an indirect read and the bundled value would be missing.
  const configuredProvider =
    process.env.NEXT_PUBLIC_HAHART_AUTH_PROVIDER?.trim();
  const isSelfAuth = configuredProvider === "self";

  return {
    serverBaseUrl: overrides.serverBaseUrl ?? getServerBaseUrl(),
    supabaseUrl:
      overrides.supabaseUrl ??
      resolveSupabaseEnv(
        "NEXT_PUBLIC_SUPABASE_URL",
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        isSelfAuth,
      ),
    supabaseAnonKey:
      overrides.supabaseAnonKey ??
      resolveSupabaseEnv(
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        isSelfAuth,
      ),
  };
}

// self auth never issues a Supabase request, so the browser-safe Supabase pair
// is optional there: requiring it would only crash `next dev` on machines that
// run the self provider (T-160). In supabase mode it stays a hard requirement.
function resolveSupabaseEnv(
  name: string,
  value: string | undefined,
  isSelfAuth: boolean,
) {
  if (isSelfAuth) {
    return value?.trim() ?? "";
  }

  return requireEnv(name, value);
}

function requireEnv(name: string, value: string | undefined) {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    throw new Error(`Missing required browser env: ${name}`);
  }

  return normalizedValue;
}
