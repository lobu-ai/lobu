import { ErrorCode, OrchestratorError } from "@lobu/core";
import { nixPackageAttrRef as nixPackageAttrRefBase } from "@lobu/connector-sdk/nix-package";

/**
 * Validate a declared Nix package name and return a safe Nix attribute
 * reference (`pkgs.<name>`). Delegates to the canonical sanitizer in
 * @lobu/connector-sdk (shared with the connector-worker executor so the two
 * paths can't drift), wrapping failures in an `OrchestratorError` for the
 * deployment surface.
 */
export function nixPackageAttrRef(pkg: string): string {
  return nixPackageAttrRefBase(
    pkg,
    (message) =>
      new OrchestratorError(ErrorCode.DEPLOYMENT_CREATE_FAILED, message)
  );
}
