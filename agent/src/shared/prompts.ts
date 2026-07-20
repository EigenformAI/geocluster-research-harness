export enum ModelFamily {
	GEOLOGY = "geology", // GeoCluster IDE geological analysis variant (always-match, first priority)
	REPORT_EVAL = "report-eval", // GeoCluster IDE "Report Analysis" mode: answers stage-specific Mining-evals questions over an extracted report
	SPECIALIST_ORCHESTRATOR = "specialist-orchestrator", // Layer 2: Analysis Orchestrator
	SPECIALIST_DATAOPS = "specialist-dataops", // Layer 3: DataOps specialist
	SPECIALIST_TRANSFORM = "specialist-transform", // Layer 3: Transform specialist
	SPECIALIST_ANALYTICS = "specialist-analytics", // Layer 3: Analytics specialist
	SPECIALIST_GEOVIZ = "specialist-geoviz", // Layer 3: GeoViz specialist
	SPECIALIST_EXTENDED = "specialist-extended", // Layer 4: Extended Capability agent
	CLAUDE = "claude",
	GPT = "gpt",
	GPT_5 = "gpt-5",
	NATIVE_GPT_5 = "gpt-5-native", // Uses native tool calling
	NATIVE_GPT_5_1 = "gpt-5-1-native", // Uses native tool calling
	GEMINI = "gemini",
	GEMINI_3 = "gemini3", // Uses native tool calling
	QWEN = "qwen",
	GLM = "glm",
	HERMES = "hermes",
	DEVSTRAL = "devstral",
	NEXT_GEN = "next-gen",
	TRINITY = "trinity",
	GENERIC = "generic",
	XS = "xs",
	NATIVE_NEXT_GEN = "native-next-gen", // Uses native tool calling
}
