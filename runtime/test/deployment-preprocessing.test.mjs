import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { preprocessingConfig } from "../lib/preprocessing-provision.js"

test("boot configuration defaults disabled and configured pair survives admission disablement", () => {
	assert.equal(preprocessingConfig({}).enabled, false)
	assert.equal(preprocessingConfig({}).aggregate, false)
	assert.throws(() => preprocessingConfig({ PREPROCESSING_ENABLED: "true" }), /aggregate/i)
	assert.equal(preprocessingConfig({ PREPROCESSING_MODEL: "proxy/openai/gpt-6-luna", PREPROCESSING_PROXY_TOKEN: "private", LLM_PROXY_URL: "http://proxy" }).configured, true)
})

test("preprocessing configuration cannot override its managed provider, model or purpose credential", () => {
	const script = new URL("../preprocessing-pair.py", import.meta.url).pathname
	const program = `
import importlib.util, json, sys
s = importlib.util.spec_from_file_location('pair', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
declared = {'name': 'Fixture', 'limit': {'context': 32000, 'input': 28000, 'output': 4000}, 'capabilities': {'tools': False, 'input': ['text', 'image'], 'output': ['text']}, 'variants': []}
catalog = {'discovery_schema_version': 2, 'managed_models': {'openai/gpt-6-luna': declared}}
boot = {'model': 'proxy/openai/gpt-6-luna', 'proxyUrl': 'http://machine/llm', 'allowModelFallback': False, 'fallbackModels': []}
good = {'model': boot['model'], 'providers': {'proxy': {'package': '@opencode/ai/providers/openrouter', 'settings': {'baseURL': boot['proxyUrl'], 'apiKey': '{env:PREPROCESSING_PROXY_TOKEN}'}, 'models': {'openai/gpt-6-luna': declared}}}}
m.managed_config(good, boot, catalog)
for bad in [dict(good, model='proxy/anthropic/claude-sonnet-4.5'), dict(good, providers={'openai': good['providers']['proxy']}), dict(good, providers={'proxy': dict(good['providers']['proxy'], settings={'baseURL': 'https://provider-direct.test', 'apiKey': '{env:PREPROCESSING_PROXY_TOKEN}'})}), dict(good, providers={'proxy': dict(good['providers']['proxy'], settings={'baseURL': boot['proxyUrl'], 'apiKey': '{env:IDE_LLM_TOKEN}'})})]:
    try: m.managed_config(bad, boot, catalog)
    except ValueError: continue
    raise AssertionError('managed model boundary bypassed')
print('managed extraction boundary verified')
`
	assert.equal(execFileSync("python3", ["-c", program, script], { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } }).trim(), "managed extraction boundary verified")
})

test("private catalog retains every installed declaration without fabricating images or permitting custom metadata", () => {
	const program = `
import importlib.util, json, sys, types
s = importlib.util.spec_from_file_location('pair', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
sys.modules['preprocessing.engine'] = types.SimpleNamespace(SYSTEM='extract')
sys.modules['preprocessing.dev'] = types.SimpleNamespace(validate_config=lambda config, secrets: config)
catalog = {'discovery_schema_version': 2, 'managed_models': {
    'new/maker/image': {'name': 'Image fixture', 'limit': {'context': 24000, 'input': 20000, 'output': 4000}, 'capabilities': {'tools': True, 'input': ['text','image'], 'output': ['text']}, 'variants': []},
    'unknown/text': {'name': 'Text fixture', 'limit': {'context': 16000, 'input': 12000, 'output': 4000}, 'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']}, 'variants': []}}}
boot = {'model': 'proxy/new/maker/image', 'proxyUrl': 'http://machine/llm', 'allowModelFallback': False, 'fallbackModels': []}
config = m.model_config(boot, catalog)
models = config['providers']['proxy']['models']
assert set(models) == set(catalog['managed_models'])
assert config['model'] == boot['model']
for model, declared in models.items():
    assert declared['capabilities']['input'] == catalog['managed_models'][model]['capabilities']['input']
    assert declared['limit'] == catalog['managed_models'][model]['limit']
    assert declared['capabilities']['tools'] is False
m.managed_config(config, boot, catalog)
import copy
for mutate in [lambda c: c['providers']['proxy']['models']['unknown/text']['capabilities'].update(input=['text','image']), lambda c: c['providers']['proxy']['models']['new/maker/image']['limit'].update(context=999999999), lambda c: c['providers']['proxy']['models']['new/maker/image'].update(settings={'baseURL':'https://untrusted'}), lambda c: c['providers']['proxy']['models'].update({'new/model': models['new/maker/image']})]:
    bad = copy.deepcopy(config); mutate(bad)
    try: m.managed_config(bad, boot, catalog)
    except ValueError: continue
    raise AssertionError('untrusted declaration accepted')
# Default extraction is image-based, while a custom text-only operation may keep
# the installed text declaration without inventing image support.
text_boot = dict(boot, model='proxy/unknown/text')
try: m.model_config(text_boot, catalog)
except ValueError: pass
else: raise AssertionError('text-only model used for default image extraction')
text_config = dict(config, model=text_boot['model'])
assert m.managed_config(text_config, text_boot, catalog) is text_config
for missing in ['proxy/not/installed', 'proxy/new/maker/image#unqualified']:
    try: m.managed_config(dict(config, model=missing), dict(boot, model=missing), catalog)
    except ValueError: continue
    raise AssertionError('uninstalled model or variant accepted')
print('trusted catalog retained; custom capability and route expansion rejected')
`
	assert.equal(execFileSync("python3", ["-c", program, new URL("../preprocessing-pair.py", import.meta.url).pathname], { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } }).trim(), "trusted catalog retained; custom capability and route expansion rejected")
})

test("boot model-policy ordered preferences and operator overrides are validated before provisioning", () => {
	assert.deepEqual(preprocessingConfig({ PREPROCESSING_FALLBACK_MODELS: '["proxy/openai/second","proxy/google/first","proxy/openai/second"]' }).fallbackModels, ["proxy/openai/second", "proxy/google/first"])
	assert.equal(preprocessingConfig({ PREPROCESSING_ALLOW_MODEL_FALLBACK: "false" }).allowModelFallback, false)
	for (const key of ["MIN_CONTEXT_TOKENS", "MIN_OUTPUT_TOKENS", "MODEL_POLICY_REFRESH_MS", "MODEL_POLICY_MAX_AGE_MS", "RETRY_COOLDOWN_MS"]) for (const value of ["0", "-1", "1.5", "", "9007199254740992", "9007199254740991.1", "Infinity", true]) assert.throws(() => preprocessingConfig({ [`PREPROCESSING_${key}`]: value }), /positive safe integer/)
	for (const value of ['null', '{}', '["openai/model"]', '["proxy/openai/model "]', '[7]', 'not json', JSON.stringify(Array(129).fill('proxy/openai/model'))]) assert.throws(() => preprocessingConfig({ PREPROCESSING_FALLBACK_MODELS: value }), /FALLBACK_MODELS/)
	assert.throws(() => preprocessingConfig({ PREPROCESSING_ALLOW_MODEL_FALLBACK: "yes" }), /true or false/)
	const risky = preprocessingConfig({ PREPROCESSING_MODEL_POLICY_REFRESH_MS: "1000", PREPROCESSING_MODEL_POLICY_MAX_AGE_MS: "500" })
	assert.equal(risky.modelPolicyRefreshMs, 1000)
	assert.equal(risky.modelPolicyMaxAgeMs, 500)
	assert.equal(risky.modelPolicyWarnings.length, 2)
})

test("operator token floors are optional and respect processor integer bounds", () => {
	const configured = preprocessingConfig({ PREPROCESSING_MIN_CONTEXT_TOKENS: "1050000", PREPROCESSING_MIN_OUTPUT_TOKENS: "32000" })
	assert.equal(configured.minContextTokens, 1050000)
	assert.equal(configured.minOutputTokens, 32000)
	for (const [envKey, bootKey] of [["PREPROCESSING_MIN_CONTEXT_TOKENS", "minContextTokens"], ["PREPROCESSING_MIN_OUTPUT_TOKENS", "minOutputTokens"]]) {
		assert.equal(preprocessingConfig({ [envKey]: "2147483647" })[bootKey], 2147483647)
		assert.throws(() => preprocessingConfig({ [envKey]: "2147483648" }), /positive safe integer/)
	}
	assert.equal(preprocessingConfig({ PREPROCESSING_MIN_OUTPUT_TOKENS: "32000" }).minContextTokens, null)
})

test("exact preferred and fallback references preserve separately requested variants", () => {
	const preferred = "proxy/openai/gpt-6-luna#high"
	assert.equal(preprocessingConfig({ PREPROCESSING_MODEL: preferred, PREPROCESSING_PROXY_TOKEN: "private", LLM_PROXY_URL: "http://proxy" }).configured, true)
	assert.deepEqual(preprocessingConfig({ PREPROCESSING_FALLBACK_MODELS: JSON.stringify([preferred, "proxy/openai/gpt-6-luna", preferred, "proxy/google/gemini-3.8-flash#low"]) }).fallbackModels, [preferred, "proxy/openai/gpt-6-luna", "proxy/google/gemini-3.8-flash#low"])
	for (const ref of ["proxy/openai/model#", "proxy/openai/model#high#low", "proxy/openai/model# high", "proxy/openai/model#/high", `proxy/openai/model#${"a".repeat(65)}`, `proxy/vendor/${"a".repeat(160)}#high`]) {
		assert.throws(() => preprocessingConfig({ PREPROCESSING_MODEL: ref }), /exact proxy model reference/)
		assert.throws(() => preprocessingConfig({ PREPROCESSING_FALLBACK_MODELS: JSON.stringify([ref]) }), /FALLBACK_MODELS/)
	}
	const program = `
import importlib.util, sys, types
s=importlib.util.spec_from_file_location('pair',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
sys.modules['preprocessing.engine']=types.SimpleNamespace(SYSTEM='extract')
sys.modules['preprocessing.dev']=types.SimpleNamespace(validate_config=lambda config,secrets: config)
declared={'name':'Fixture','limit':{'context':1050000,'input':1000000,'output':32000},'capabilities':{'tools':True,'input':['text','image'],'output':['text']},'variants':[{'id':'high','settings':{'reasoning':{'effort':'high'}}}]}
catalog={'discovery_schema_version':2,'managed_models':{'openai/gpt-6-luna':declared}}
boot={'model':'proxy/openai/gpt-6-luna#high','proxyUrl':'http://machine/llm'}
config=m.model_config(boot,catalog)
assert config['model'] == boot['model']
m.managed_config(config,boot,catalog)
assert config['providers']['proxy']['models']['openai/gpt-6-luna']['variants'] == declared['variants']
try: m.managed_config(dict(config,model='proxy/openai/gpt-6-luna'),boot,catalog)
except ValueError: pass
else: raise AssertionError('preferred variant was silently stripped')
print('exact qualified variant retained')
`
	assert.equal(execFileSync("python3", ["-B", "-c", program, new URL("../preprocessing-pair.py", import.meta.url).pathname], { encoding: "utf8" }).trim(), "exact qualified variant retained")
})

test("bundle includes working-tree bytes, lock and standalone supervisor; digest detects changed source", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-bundle-"))
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const source = path.join(dir, "source")
	await fs.mkdir(path.join(source, "preprocessing"), { recursive: true })
	await fs.mkdir(path.join(source, "deployment/standalone"), { recursive: true })
	await fs.writeFile(path.join(source, "pyproject.toml"), '[project]\nname="fixture"\nversion="0.1"\n')
	await fs.writeFile(path.join(source, "uv.lock"), "locked\n")
	await fs.writeFile(path.join(source, "preprocessing/__init__.py"), "dirty_worktree = True\n")
	await fs.writeFile(path.join(source, "deployment/standalone/supervise.py"), "standalone = True\n")
	const script = new URL("../../scripts/preprocessing-bundle.py", import.meta.url).pathname
	const run = () => JSON.parse(execFileSync("python3", [script, "--source", source, "--output", path.join(dir, "bundle")], { encoding: "utf8" }))
	const first = run()
	assert.equal(first.digest, run().digest)
	execFileSync("tar", ["-xf", path.join(dir, "bundle/source.tar"), "-C", dir])
	assert.match(await fs.readFile(path.join(dir, "preprocessing/__init__.py"), "utf8"), /dirty_worktree = True/)
	assert.equal(await fs.readFile(path.join(dir, "deployment/standalone/supervise.py"), "utf8"), "standalone = True\n")
	await fs.writeFile(path.join(source, "preprocessing/__init__.py"), "dirty_worktree = False\n")
	assert.notEqual(run().digest, first.digest)
})
