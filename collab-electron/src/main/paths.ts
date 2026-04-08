import { join } from "node:path";
import { homedir } from "node:os";

const BASE = join(homedir(), ".collaborator");

export const COLLAB_DIR = import.meta.env?.DEV ? join(BASE, "dev") : BASE;

/** Shared across dev and production — used for the PTY sidecar so that
 *  terminal sessions survive switching between dev and production mode. */
export const COLLAB_SHARED_DIR = BASE;
