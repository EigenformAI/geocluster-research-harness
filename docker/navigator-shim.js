// Shim globalThis.navigator for code-server's extension host.
// code-server 4.109+ traps navigator access with PendingMigrationError
// unless --supportGlobalNavigator is passed. The setting
// "extensions.supportNodeGlobalNavigator" only works in VS Code desktop,
// not in code-server's remote server. This preload script defines
// navigator before the trap is installed.
if (typeof globalThis.navigator === "undefined") {
	Object.defineProperty(globalThis, "navigator", {
		value: { userAgent: "node" },
		writable: true,
		configurable: true,
		enumerable: false,
	})
}
