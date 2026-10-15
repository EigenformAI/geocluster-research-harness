import { catalogDigest, catalogIdentity, discoveryReason, fetchDiscovery, managedModelId, validateCatalogArtifact } from "./managed-catalog.js"

/** Advisory discovery only; every supplier request is separately admitted by the backend. */
export class AccountUsage {
	constructor(config, { fetchImpl = globalThis.fetch, logger } = {}) {
		this.config = config; this.fetch = fetchImpl; this.snapshot = null; this.available = false
		this.logger = logger
		this.installed = config.managedCatalog ?? null
		this.catalogRestartRequired = false
		this.reason = null
	}
	refresh() {
		if (this.pending) return this.pending
		this.pending = this.#fetch().finally(() => { this.pending = null })
		return this.pending
	}
	async #fetch() {
		try {
			if (this.installed?.backendBaseUrl) {
				try { validateCatalogArtifact(this.installed, catalogIdentity(this.config)); this.identityMatches = true }
				catch (error) { this.snapshot = null; this.identityMatches = false; throw error }
			}
			const value = await fetchDiscovery(this.config, { fetchImpl: this.fetch })
			const installed = this.installed?.catalog
			// Removed eligibility need not mutate the engine. New/changed declarations and defaults do.
			this.catalogRestartRequired = !installed || value.default_model_id !== installed.default_model_id || Object.entries(value.managed_models).some(([id, declaration]) => !Object.hasOwn(installed.managed_models, id) || catalogDigest({ default_model_id: null, managed_models: { [id]: declaration } }) !== catalogDigest({ default_model_id: null, managed_models: { [id]: installed.managed_models[id] } }))
			this.snapshot = value
			this.available = true
			this.reason = null
		} catch (error) { this.available = false; this.reason = discoveryReason(error) }
		const status = this.status(), key = JSON.stringify({ ...status, reason: this.reason })
		if (key !== this.lastLogged) { this.logger?.info("managed model discovery", { ...status, reason: this.reason }); this.lastLogged = key }
	}
	installedModel(model) { const id = managedModelId(model); return this.identityMatches !== false && id !== null && Boolean(this.installed?.catalog && Object.hasOwn(this.installed.catalog.managed_models, id)) }
	allowed(model) { return this.installedModel(model) && Boolean(this.snapshot?.allowed_model_ids.includes(managedModelId(model))) }
	get modelSessionsAvailable() { return this.identityMatches !== false && this.installed?.catalog?.default_model_id != null }
	status() {
		return { state: this.available ? "fresh" : this.snapshot ? "stale" : "unavailable", schemaVersion: this.snapshot?.discovery_schema_version ?? this.installed?.discoverySchemaVersion ?? null, installedCatalogDigest: this.installed?.digest ?? null, catalogRestartRequired: this.catalogRestartRequired }
	}
	filter(options) {
		return options?.map?.((option) => option.id !== "model" ? option : {
			...option, currentValue: this.allowed(option.currentValue) ? option.currentValue : null,
			_meta: { ...option._meta, unavailableModelId: this.allowed(option.currentValue) ? null : option.currentValue ?? null },
			options: (option.options ?? []).filter((item) => this.allowed(item.value)),
		}) ?? null
	}
}
