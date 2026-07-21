import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	renderSectionHeader: (tabId: string) => JSX.Element | null
}
const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<h2 className="text-lg font-semibold">Geology Agent v{version}</h2>
					<p>
						A geology-focused AI research agent for your IDE. It analyzes geochemistry tables, well logs, rasters, and
						technical reports using specialist agents and geoscience MCP tools, and can create & edit files and
						execute terminal commands (after you grant permission). Part of the Geocluster Research Harness.
					</p>

					<h3 className="text-md font-semibold">Development</h3>
					<p>
						<VSCodeLink href="https://github.com/EigenformAI/geocluster-research-harness">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/EigenformAI/geocluster-research-harness/issues"> Issues</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">Attribution</h3>
					<p>
						Built on <VSCodeLink href="https://github.com/cline/cline">Cline</VSCodeLink> (Apache-2.0). This fork is
						not affiliated with or endorsed by the Cline team.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
