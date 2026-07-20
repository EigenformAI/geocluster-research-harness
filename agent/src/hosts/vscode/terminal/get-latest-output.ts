import { readTextFromClipboard, writeTextToClipboard } from "@utils/env"
import * as vscode from "vscode"

/**
 * Gets the contents of the active terminal
 * @returns The terminal contents as a string
 */
export async function getLatestTerminalOutput(): Promise<string> {
	// Store original clipboard content to restore later
	const originalClipboard = await readTextFromClipboard()

	try {
		// Select terminal content
		try {
			await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
		} catch (error) {
			// Command not supported (e.g. in Theia), return empty string to avoid crash
			return ""
		}

		// Copy selection to clipboard
		try {
			await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
		} catch (error) {
			return ""
		}

		// Clear the selection
		try {
			await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")
		} catch (error) {
			// Ignore cleanup error
		}

		// Get terminal contents from clipboard
		let terminalContents = (await readTextFromClipboard()).trim()

		// Check if there's actually a terminal open
		if (terminalContents === originalClipboard) {
			return ""
		}

		// Clean up command separation
		const lines = terminalContents.split("\n")
		const lastLine = lines.pop()?.trim()
		if (lastLine) {
			let i = lines.length - 1
			while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
				i--
			}
			terminalContents = lines.slice(Math.max(i, 0)).join("\n")
		}

		return terminalContents
	} finally {
		// Restore original clipboard content
		await writeTextToClipboard(originalClipboard)
	}
}
