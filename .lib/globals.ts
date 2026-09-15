import { c as _c } from "@zodiaceco/sdk";
import type * as types from "./types";
import { allow as _allow } from "./allow";

declare global {
  var allow: typeof _allow;
  var c: typeof _c;
  type Members = types.Members;
  type Permissions = types.Permissions;
}

globalThis.allow = _allow;
globalThis.c = _c;
