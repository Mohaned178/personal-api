import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PatchedBuild {
  /** Directory holding a copy of the build whose manifest also lists `host_permissions`. */
  path: string;
  cleanup(): Promise<void>;
}

/**
 * Copies a built extension and adds `host_permissions` to the copy's manifest.
 *
 * Why: the real build requests the server's origin at runtime (`optional_host_permissions` +
 * `permissions.request`), and the browser shows a permission prompt that no automation can click.
 * The e2e tests need that prompt to be a no-op, so the copy has the permission up front; the
 * request is then answered "already granted" and the rest of the connect flow runs unchanged.
 * Nothing but the manifest differs from the shipped build. The shipped build is never modified.
 */
export async function patchBuildWithHostPermissions(
  buildPath: string,
  hostPermissions: readonly string[],
): Promise<PatchedBuild> {
  const root = await mkdtemp(join(tmpdir(), "pa-e2e-build-"));
  const path = join(root, "build");
  await cp(buildPath, path, { recursive: true });
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = [...hostPermissions];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    path,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

/** The match pattern for any port on the loopback host the fixture, API and proxy listen on. */
export const LOOPBACK_HOST_PERMISSION = "http://127.0.0.1/*";
