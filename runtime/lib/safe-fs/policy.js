const reserved = new Set([".runtime", ".git", ".upload-tmp", ".datasets-staging", ".ide-state", ".clinerules"])

export class SafeFsError extends Error {
	constructor(code, operation, message, details = {}) {
		super(`safe-fs.${operation}: ${message}`)
		Object.assign(this, { code, agent: "file-service", tool: `safe-fs.${operation}`, action: "Inspect the path, policy, and filesystem configuration before retrying.", ...details })
	}
}

export function canonicalPath(value, { root = true } = {}) {
	if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/u.test(value) || /[\ud800-\udfff]/u.test(value) || (!value && !root) || (value && value.split("/").some((part) => !part || part === "." || part === ".."))) {
		throw new SafeFsError("EINVAL", "path", "Use a canonical UTF-8 POSIX relative path without controls, backslashes, dot, or empty components.", { reason: "invalid_path" })
	}
	return value
}

export const isReserved = (name) => reserved.has(name) || name.startsWith(".gc-file-")
export const contains = (root, name) => root === "" || name === root || name.startsWith(`${root}/`)

export class SafePolicy {
	#roots = []
	#hiddenIdentities = []
	#register
	constructor({ protectedRoots = [], hiddenRoots = [] } = {}) {
		for (const [paths, access] of [[protectedRoots, "read-only"], [hiddenRoots, "hidden"]]) {
			if (!Array.isArray(paths)) throw new SafeFsError("EINVAL", "policy", "Policy roots must be arrays of relative paths.")
			for (const path of paths) this.add({ path: canonicalPath(path), access })
		}
	}
	get roots() { return this.#roots.map((entry) => ({ ...entry })) }
	get hasPins() { return this.#hiddenIdentities.length > 0 || this.#roots.some((entry) => entry.identity) }
	protectIdentity(path, identity) {
		const pinned = [...this.#roots, ...this.#hiddenIdentities]
		if (pinned.some((entry) => entry.access === "hidden" && entry.identity?.dev === identity.dev && entry.identity.ino === identity.ino)) return false
		this.#hiddenIdentities.push(Object.freeze({ path, identity, access: "hidden" }))
		return true
	}
	bind(register) { this.#register = register }
	register(entry) {
		if (!this.#register) throw new SafeFsError("EINVAL", "register", "Registration needs an opened SafeFs instance.")
		return this.#register(entry)
	}
	checkRegistration({ path, access } = {}) {
		canonicalPath(path, { root: false })
		if (!["read-only", "hidden"].includes(access)) throw new SafeFsError("EINVAL", "register", "Use read-only or hidden access.")
		if (path.split("/").some(isReserved)) throw new SafeFsError("EEXIST", "register", "The path collides with an implicit reserved root.", { reason: "reserved_component", path })
		const collision = this.#roots.find((entry) => contains(entry.path, path) || contains(path, entry.path))
		if (collision) throw new SafeFsError("EEXIST", "register", "The path overlaps a registered root.", { reason: "policy_collision", path, conflictPath: collision.path })
	}
	add(entry) {
		// Initial roots may name reserved directories; those remain implicitly hidden.
		const collision = this.#roots.find((root) => contains(root.path, entry.path) || contains(entry.path, root.path))
		if (collision) throw new SafeFsError("EEXIST", "register", "The path overlaps a registered root.", { reason: "policy_collision", path: entry.path, conflictPath: collision.path })
		this.#roots.push(Object.freeze({ ...entry }))
	}
	pin(path, identity, parentIdentity) {
		this.#roots = this.#roots.map((entry) => entry.path === path ? Object.freeze({ ...entry, identity, parentIdentity }) : entry)
	}
	assertIdentity(stat, access = "read") {
		const entry = [...this.#roots, ...this.#hiddenIdentities].find((root) => root.identity && String(stat.dev) === root.identity.dev && String(stat.ino) === root.identity.ino && (access === "write" || root.access === "hidden"))
		if (entry) throw new SafeFsError("EACCES", "policy", "The pinned object belongs to a protected root.", { reason: access === "write" ? "read_only_root" : "hidden_root", path: entry.path })
	}
	visible(path) {
		try { this.assertRead(path); return true } catch (error) { if (["EINVAL", "EACCES"].includes(error.code)) return false; throw error }
	}
	assertRead(path) {
		canonicalPath(path)
		if (path.split("/").some(isReserved)) throw new SafeFsError("EACCES", "policy", "A reserved component is hidden.", { reason: "reserved_component", path })
		if (this.#roots.some((entry) => entry.access === "hidden" && contains(entry.path, path))) throw new SafeFsError("EACCES", "policy", "This root is hidden.", { reason: "hidden_root", path })
		return path
	}
	assertWrite(path, { subtree = false } = {}) {
		this.assertRead(path)
		if (this.#roots.some((entry) => contains(entry.path, path))) throw new SafeFsError("EACCES", "policy", "This root is read-only.", { reason: "read_only_root", path })
		const descendant = subtree && this.#roots.find((entry) => contains(path, entry.path))
		if (descendant) throw new SafeFsError("EACCES", "policy", "This subtree contains a protected root.", { reason: "protected_descendant", path, protectedPath: descendant.path })
		return path
	}
}
