import type { Permissions as SdkPermissions } from "@zodiaceco/sdk";

export type Members = readonly `0x${string}`[];

/**
 * A role's permission list. Re-exported from the SDK rather than restated, so
 * `permissions.ts` files are checked against the shape `push()` actually takes:
 * a bare `allow`-kit permission, or one of the labelled entries from
 * `@zodiaceco/sdk/actions`. A compiled `PermissionSet` — what calling `defi-kit`
 * directly returns — is not one of them.
 */
export type Permissions = SdkPermissions;
