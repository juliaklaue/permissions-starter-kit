import { defikit } from "@zodiaceco/sdk/actions";

export default [
  defikit.aave_v3.deposit({
    label: "Supply USDC and WETH to Aave v3",
    market: "Core",
    targets: ["USDC", "WETH"],
  }),
  defikit.aave_v3.borrow({
    label: "Borrow USDC and WETH from Aave v3",
    market: "Core",
    targets: ["USDC", "WETH"],
  }),
] satisfies Permissions;
