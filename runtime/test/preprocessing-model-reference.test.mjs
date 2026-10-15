import assert from "node:assert/strict"
import { test } from "node:test"
import { preprocessingConfig } from "../lib/preprocessing-provision.js"

test("processor preferences accept opaque managed IDs without inventing maker/path syntax", () => {
	for (const id of ["plain-model", "vendor/model+v2", "vendor/nested/model", "maker/模型"]) {
		for (const ref of [`proxy/${id}`, `proxy/${id}#high`]) {
			const config = preprocessingConfig({ PREPROCESSING_MODEL: ref, LLM_PROXY_URL: "http://relay/llm", PREPROCESSING_PROXY_TOKEN: "private-channel", PREPROCESSING_FALLBACK_MODELS: JSON.stringify([ref]) })
			assert.equal(config.configured, true, ref)
			assert.deepEqual(config.fallbackModels, [ref])
		}
	}
	for (const ref of ["proxy/model?key", "proxy/model:route", "proxy/model\\escape", "proxy/model\n", "proxy/model#high#low", "proxy/model#"]) {
		assert.throws(() => preprocessingConfig({ PREPROCESSING_MODEL: ref }), /exact proxy model reference/)
		assert.throws(() => preprocessingConfig({ PREPROCESSING_FALLBACK_MODELS: JSON.stringify([ref]) }), /FALLBACK_MODELS/)
	}
})
