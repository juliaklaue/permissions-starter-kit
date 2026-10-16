export default [
  allow.eth.weth.deposit({ send: true }),
  allow.eth.weth.withdraw(),
] satisfies Permissions;
