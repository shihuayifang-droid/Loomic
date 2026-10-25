import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * 43M guard: `deploy/` is only reviewed structurally -- CI has no Docker daemon,
 * so the compose file is parsed as YAML and nginx.conf / the env template are
 * read as text. A real `docker compose up` (and the browser Network check) is
 * part of the .37 deployment acceptance, not of this suite.
 */
const COMPOSE_TEXT = readFileSync(
  new URL("../../../../deploy/docker-compose.yml", import.meta.url),
  "utf8",
);
const NGINX_TEXT = readFileSync(
  new URL("../../../../deploy/nginx.conf", import.meta.url),
  "utf8",
);
const ENV_EXAMPLE_TEXT = readFileSync(
  new URL("../../../../deploy/.env.production.example", import.meta.url),
  "utf8",
);
const ENV_SOURCE = readFileSync(
  new URL("../config/env.ts", import.meta.url),
  "utf8",
);
const WEB_DOCKERFILE_TEXT = readFileSync(
  new URL("../../../../apps/web/Dockerfile", import.meta.url),
  "utf8",
);

/** The `objects` volume is mounted at the same path in server and worker. */
const OBJECTS_VOLUME = "objects";
const OBJECTS_MOUNT_TARGET = "/data/objects";
const SERVER_CONTAINER_PORT = 3001;

type ComposeService = {
  build?: { context?: string; dockerfile?: string };
  depends_on?: Record<string, { condition?: string }> | string[];
  env_file?: string | string[];
  environment?: Record<string, string> | string[];
  healthcheck?: { test?: string | string[] };
  image?: string;
  /** 45CI: the tunnel sidecar joins the `web` container network namespace. */
  network_mode?: string;
  ports?: string[];
  /** 45CI: services behind a profile only start with `--profile <name>`. */
  profiles?: string[];
  volumes?: string[];
};

type ComposeFile = {
  services?: Record<string, ComposeService>;
  version?: string;
  volumes?: Record<string, unknown>;
};

const COMPOSE = (parse(COMPOSE_TEXT) ?? {}) as ComposeFile;
const SERVICES: Record<string, ComposeService> = COMPOSE.services ?? {};

function service(name: string): ComposeService {
  const found = SERVICES[name];
  expect(found, `deploy/docker-compose.yml has no "${name}" service`).toBeDefined();
  if (!found) {
    throw new Error(`deploy/docker-compose.yml has no "${name}" service`);
  }
  return found;
}

/** `environment` is authocthonous in both spellings; normalise to a map. */
function environmentOf(name: string): Record<string, string> {
  const raw = service(name).environment;
  const out: Record<string, string> = {};
  if (!raw) {
    return out;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        out[entry] = "";
      } else {
        out[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
    }
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value;
  }
  return out;
}

function buildDockerfile(name: string): string | undefined {
  const build = service(name).build;
  return build && "dockerfile" in build ? build.dockerfile : undefined;
}

function buildContext(name: string): string | undefined {
  const build = service(name).build;
  return build && "context" in build ? build.context : undefined;
}

function volumesOf(name: string): string[] {
  return service(name).volumes ?? [];
}

function healthcheckCommand(name: string): string {
  const test = service(name).healthcheck?.test;
  if (!test) {
    return "";
  }
  return Array.isArray(test) ? test.join(" ") : test;
}

/** Repository-root mount target of a named volume, or undefined when unmounted. */
function mountTarget(name: string, volumeName: string): string | undefined {
  const prefix = `${volumeName}:`;
  for (const entry of volumesOf(name)) {
    if (entry.startsWith(prefix)) {
      return entry.slice(prefix.length);
    }
  }
  return undefined;
}

type EnvEntry = { key: string; value: string };

const ENV_ENTRIES: EnvEntry[] = [];
for (const match of ENV_EXAMPLE_TEXT.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) {
  const key = match[1];
  if (!key) {
    continue;
  }
  ENV_ENTRIES.push({ key, value: (match[2] ?? "").trim() });
}

function envExampleValue(key: string): string | undefined {
  for (const entry of ENV_ENTRIES) {
    if (entry.key === key) {
      return entry.value;
    }
  }
  return undefined;
}

function envExampleKeys(): string[] {
  return ENV_ENTRIES.map((entry) => entry.key);
}

/**
 * Text of one `location <prefix> { ... }` block. Blocks in this file do not
 * nest, so the first 4-space indented closing brace ends it.
 */
function locationBlock(prefix: string): string {
  const marker = `location ${prefix} {`;
  const start = NGINX_TEXT.indexOf(marker);
  expect(start, `deploy/nginx.conf has no "${marker}" block`).toBeGreaterThanOrEqual(0);
  const end = NGINX_TEXT.indexOf("\n    }", start);
  expect(end, `deploy/nginx.conf block "${marker}" is not closed`).toBeGreaterThan(start);
  return NGINX_TEXT.slice(start, end);
}

describe("43M deploy/docker-compose.yml", () => {
  it("43M: declares exactly the four production services by default", () => {
    // 45CI added a fifth service, `cloudflared`, behind `profiles: ["tunnel"]`,
    // so a plain `docker compose up` still starts exactly these four.
    const enabledByDefault = Object.keys(SERVICES)
      .filter((name) => !SERVICES[name]?.profiles)
      .sort();

    expect(enabledByDefault).toEqual(["postgres", "server", "web", "worker"]);
  });

  it("45CI: cloudflared is the only profiled service and shares the web network", () => {
    expect(Object.keys(SERVICES)).toContain("cloudflared");

    const profiled = Object.keys(SERVICES)
      .filter((name) => SERVICES[name]?.profiles)
      .sort();
    expect(profiled).toEqual(["cloudflared"]);

    const cloudflared = service("cloudflared");
    expect(cloudflared.profiles).toEqual(["tunnel"]);
    // The tunnel publishes nothing; nginx keeps owning the only host port.
    expect(cloudflared.ports).toBeUndefined();
    // Necessary so cloudflared can reach nginx on 127.0.0.1 inside `web`.
    expect(cloudflared.network_mode).toBe("service:web");
  });

  it("45CI: the four default services never hide behind a profile", () => {
    for (const name of ["postgres", "server", "web", "worker"]) {
      expect(service(name).profiles, `${name} must not declare profiles`).toBeUndefined();
    }
  });

  it("43M: uses compose spec v2 (no top-level version key)", () => {
    expect(COMPOSE.version).toBeUndefined();
  });

  it("43M: postgres keeps its data on a volume, is healthchecked and takes its password from the environment", () => {
    const postgres = service("postgres");

    expect(postgres.image).toBe("postgres:16-alpine");
    expect(volumesOf("postgres")).toContain("pgdata:/var/lib/postgresql/data");
    expect(healthcheckCommand("postgres")).toContain("pg_isready");

    const password = environmentOf("postgres").POSTGRES_PASSWORD ?? "";
    expect(password).toContain("${POSTGRES_PASSWORD");
    // No literal credential in the file: the whole value must be an interpolation.
    expect(password.startsWith("${")).toBe(true);
  });

  it("43M: server and worker share one image and differ only by SERVICE_MODE", () => {
    expect(buildDockerfile("server")).toBe("apps/server/Dockerfile");
    expect(buildDockerfile("worker")).toBe(buildDockerfile("server"));
    expect(buildContext("server")).toBe("..");

    expect(environmentOf("server").SERVICE_MODE).toBe("api");
    expect(environmentOf("worker").SERVICE_MODE).toBe("worker");
  });

  it("43M: server and worker share the objects volume", () => {
    expect(mountTarget("server", OBJECTS_VOLUME)).toBe(OBJECTS_MOUNT_TARGET);
    expect(mountTarget("worker", OBJECTS_VOLUME)).toBe(OBJECTS_MOUNT_TARGET);
  });

  it("43M: server is health-probed and never publishes a port", () => {
    const server = service("server");
    const dependsOn = server.depends_on;

    expect(healthcheckCommand("server")).toContain(
      `http://127.0.0.1:${SERVER_CONTAINER_PORT}/api/health`,
    );
    expect(server.ports).toBeUndefined();

    expect(dependsOn).toBeDefined();
    if (!dependsOn || Array.isArray(dependsOn)) {
      throw new Error("server.depends_on must use the long form with a condition");
    }
    expect(dependsOn.postgres?.condition).toBe("service_healthy");
  });

  it("43M: web is published on loopback only and waits for the server", () => {
    const web = service("web");

    expect(buildDockerfile("web")).toBe("apps/web/Dockerfile");

    const ports = web.ports ?? [];
    expect(ports).toHaveLength(1);
    for (const entry of ports) {
      expect(entry.startsWith("127.0.0.1:")).toBe(true);
      expect(entry.endsWith(":80")).toBe(true);
    }
    expect(ports[0]).toBe(`127.0.0.1:8080:80`);

    const dependsOn = web.depends_on;
    expect(Array.isArray(dependsOn) ? dependsOn : Object.keys(dependsOn ?? {})).toContain(
      "server",
    );
  });

  it("43M: both named volumes are declared at the top level", () => {
    const declared = Object.keys(COMPOSE.volumes ?? {});

    expect(declared).toContain("pgdata");
    expect(declared).toContain(OBJECTS_VOLUME);
  });

  it("43M: the compose file never mentions Supabase", () => {
    expect(COMPOSE_TEXT).not.toContain("SUPABASE_");
  });
});

describe("43M deploy/.env.production.example", () => {
  it("43M: the env template never mentions Supabase", () => {
    expect(ENV_EXAMPLE_TEXT).not.toContain("SUPABASE_");
  });

  it("43M: the three production providers are the self-built ones", () => {
    expect(envExampleValue("HAHART_AUTH_PROVIDER")).toBe("self");
    expect(envExampleValue("HAHART_STORAGE_PROVIDER")).toBe("fs");
    expect(envExampleValue("HAHART_QUEUE_PROVIDER")).toBe("native");
  });

  it("43M: HAHART_OBJECT_ROOT matches the objects volume mount point", () => {
    expect(envExampleValue("HAHART_OBJECT_ROOT")).toBe(OBJECTS_MOUNT_TARGET);
    expect(mountTarget("server", OBJECTS_VOLUME)).toBe(
      envExampleValue("HAHART_OBJECT_ROOT"),
    );
  });

  it("43M: every key in the template is a key src/config/env.ts really reads", () => {
    const keys = envExampleKeys();

    // POSTGRES_PASSWORD configures the postgres image, not the server process.
    const serverKeys = keys.filter((key) => key !== "POSTGRES_PASSWORD");
    expect(serverKeys.length).toBeGreaterThan(0);

    const unknown = serverKeys.filter((key) => !ENV_SOURCE.includes(key));

    expect(
      unknown,
      `keys in deploy/.env.production.example that src/config/env.ts does not read: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("43M: credential-shaped keys carry no value", () => {
    const secretShaped = ENV_ENTRIES.filter((entry) =>
      /(KEY|SECRET|TOKEN|PASSWORD)$/.test(entry.key),
    );
    expect(secretShaped.length).toBeGreaterThan(0);

    const filled = secretShaped
      .filter((entry) => entry.value !== "")
      .map((entry) => entry.key);

    expect(
      filled,
      `credential keys with a value in deploy/.env.production.example: ${filled.join(", ")}`,
    ).toEqual([]);
  });
});

describe("43M deploy/nginx.conf", () => {
  it("43M: serves the static export on port 80 and falls back to index.html", () => {
    expect(NGINX_TEXT).toContain("listen 80;");
    expect(NGINX_TEXT).toContain("root /usr/share/nginx/html;");

    const root = locationBlock("/");
    expect(root).toContain("try_files $uri $uri.html $uri/ /index.html");
  });

  it("43M: proxies /api/ to the server container without buffering", () => {
    const api = locationBlock("/api/");

    expect(api).toContain("proxy_pass $hahart_api");
    expect(api).toContain("proxy_set_header Host");
    expect(api).toContain("X-Forwarded-For");
    expect(api).toContain("X-Forwarded-Proto");
    expect(api).toContain("client_max_body_size 50m");
  });

  it("43M: proxies /objects/ and keeps Range responses unbuffered", () => {
    const objects = locationBlock("/objects/");

    expect(objects).toContain("proxy_pass $hahart_api");
    expect(objects).toContain("proxy_buffering off");
  });

  it("43M: upgrades /api/ws instead of proxying it as plain HTTP", () => {
    const ws = locationBlock("/api/ws");

    expect(ws).toContain("proxy_pass $hahart_api");
    expect(ws).toContain("proxy_http_version 1.1");
    expect(ws).toContain("Upgrade $http_upgrade");
    expect(ws).toContain('Connection "upgrade"');
    expect(ws).toContain("proxy_read_timeout 3600s");
  });

  it("45E: re-resolves the server container per request via Docker DNS", () => {
    expect(NGINX_TEXT).toContain("resolver 127.0.0.11");
    expect(NGINX_TEXT).toContain("set $hahart_api http://server:3001;");
    expect(NGINX_TEXT).not.toContain("proxy_pass http://server:3001");
  });
});

describe("43M apps/web/Dockerfile", () => {
  it("43M: defaults NEXT_PUBLIC_SERVER_BASE_URL to the same-origin sentinel", () => {
    // getServerBaseUrl() maps this value to "", so the bundle calls the host
    // nginx proxies instead of http://localhost:3001.
    expect(WEB_DOCKERFILE_TEXT).toMatch(/^ARG NEXT_PUBLIC_SERVER_BASE_URL=same-origin$/m);
  });

  it("43M: still serves the static export through the same-origin nginx config", () => {
    expect(WEB_DOCKERFILE_TEXT).toContain("FROM nginx:1.27-alpine");
    expect(WEB_DOCKERFILE_TEXT).toContain(
      "COPY --from=build /app/apps/web/out /usr/share/nginx/html",
    );
    expect(WEB_DOCKERFILE_TEXT).toContain(
      "COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf",
    );
  });
});
