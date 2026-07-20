/**
 * Layer 4: Extended Capability Agent Variant
 *
 * Package installation, web research, custom scripts.
 * Spawned as child process via dispatch_specialist.
 * Tier 3 (full): all commands, package install, write anywhere.
 */
import { ModelFamily } from "@/shared/prompts"
import { SpecialistType } from "@/shared/specialists"
import { ClineDefaultTool } from "@/shared/tools"
import { SystemPromptSection } from "../../../templates/placeholders"
import { createVariant } from "../../variant-builder"
import { SPECIALIST_RESULT_PROTOCOL } from "../shared"

const EXTENDED_ROLE = `You are the Extended Capability Agent in a geological analysis environment.

Your responsibilities:
- Install Python packages, system tools, and libraries
- Perform web research to find solutions
- Write and execute custom scripts when needed
- Build development environments for specialist tasks

You have full system access. Use it responsibly:
- Install packages using pip, apt, or conda as specified
- Verify installations succeed before reporting completion
- If a fallback approach was specified in the task context, use it if the primary install fails
- Web research should be focused and targeted

${SPECIALIST_RESULT_PROTOCOL}`

const EXTENDED_OBJECTIVE = `Execute the capability task described in your objective.

For package installations:
- Install the requested package with the specified version constraint
- Verify the installation by importing the package
- Report success or failure with error details

For web research:
- Search for the requested information
- Return structured findings relevant to the geological analysis context

For custom scripts:
- Write the script to the specified location
- Test execution and report results`

export const config = createVariant(ModelFamily.SPECIALIST_EXTENDED)
	.description("Layer 4: Extended Capability Agent — installs, web research, custom scripts")
	.version(1)
	.tags("specialist", "extended", "layer-4")
	.labels({ specialist: 1 })
	.matcher((context) => context.activeSpecialist === SpecialistType.EXTENDED)
	.components(
		SystemPromptSection.AGENT_ROLE,
		SystemPromptSection.TOOL_USE,
		SystemPromptSection.RULES,
		SystemPromptSection.SYSTEM_INFO,
		SystemPromptSection.OBJECTIVE,
	)
	.tools(
		ClineDefaultTool.BASH,
		ClineDefaultTool.FILE_NEW,
		ClineDefaultTool.FILE_READ,
		ClineDefaultTool.FILE_EDIT,
		ClineDefaultTool.LIST_FILES,
		ClineDefaultTool.LIST_CODE_DEF,
		ClineDefaultTool.SEARCH,
		ClineDefaultTool.WEB_FETCH,
		// WEB_SEARCH and WEB_FETCH require contextRequirements: providerId === "cline" && clineWebToolsEnabled.
		// With OpenRouter provider these tools won't render in the prompt. Added for future-proofing.
		ClineDefaultTool.WEB_SEARCH,
		ClineDefaultTool.ATTEMPT,
	)
	.overrideComponent(SystemPromptSection.AGENT_ROLE, {
		template: EXTENDED_ROLE,
	})
	.overrideComponent(SystemPromptSection.OBJECTIVE, {
		template: EXTENDED_OBJECTIVE,
	})
	.placeholders({ MODEL_FAMILY: "specialist-extended" })
	.config({})
	.build()

export type ExtendedVariantConfig = typeof config
