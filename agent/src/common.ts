import * as vscode from "vscode"
import { WebviewProvider } from "./core/webview"
import "./utils/path" // necessary to have access to String.prototype.toPosix

import { openRouterDefaultModelId } from "@shared/api"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker"
import { clearOnboardingModelsCache } from "./core/controller/models/getClineOnboardingModels"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { HookProcessRegistry } from "./core/hooks/HookProcessRegistry"
import { StateManager } from "./core/storage/StateManager"
import { openAiCodexOAuthManager } from "./integrations/openai-codex/oauth"
import { ExtensionRegistryInfo } from "./registry"
import { BannerService } from "./services/banner/BannerService"
import { audioRecordingService } from "./services/dictation/AudioRecordingService"
import { ErrorService } from "./services/error"
import { featureFlagsService } from "./services/feature-flags"
import { getDistinctId, initializeDistinctId } from "./services/logging/distinctId"
import { telemetryService } from "./services/telemetry"
import { PostHogClientProvider } from "./services/telemetry/providers/posthog/PostHogClientProvider"
import { ClineTempManager } from "./services/temp"
import { cleanupTestMode } from "./services/test/TestMode"
import { ShowMessageType } from "./shared/proto/host/window"
import { syncWorker } from "./shared/services/worker/sync"
import { getBlobStoreSettingsFromEnv } from "./shared/services/worker/worker"
import { getLatestAnnouncementId } from "./utils/announcements"
import { arePathsEqual } from "./utils/path"

/**
 * Performs intialization for Cline that is common to all platforms.
 *
 * @param context
 * @returns The webview provider
 * @throws ClineConfigurationError if endpoints.json exists but is invalid
 */
export async function initialize(context: vscode.ExtensionContext): Promise<WebviewProvider> {
	// Configure the shared Logging class to use HostProvider's output channels and debug logger
	Logger.subscribe((msg: string) => HostProvider.get().logToChannel(msg)) // File system logging
	Logger.subscribe((msg: string) => HostProvider.env.debugLog({ value: msg })) // Host debug logging

	// Initialize ClineEndpoint configuration first (reads ~/.cline/endpoints.json if present)
	// This must be done before any other code that calls ClineEnv.config()
	// Throws ClineConfigurationError if config file exists but is invalid
	const { ClineEndpoint } = await import("./config")
	await ClineEndpoint.initialize()

	// Set the distinct ID for logging and telemetry
	await initializeDistinctId(context)

	try {
		await StateManager.initialize(context)

		// Pre-configure OpenRouter API key from environment variable
		// Pass context so we can write directly to globalState (bypasses race with migrations)
		await configureOpenRouterFromEnv(context)

		// Detect non-VS-Code environments (Theia, GeologyIDE, etc.) and configure
		// backgroundExec mode. Theia's shell integration API is unreliable and can cause
		// command execution to hang. backgroundExec uses child_process.spawn directly.
		// NOTE: Theia spawns extension hosts with a sanitized environment, so Docker
		// ENV vars (THEIA_DEFAULT_PLUGINS, etc.) are NOT available here.
		// Use vscode.env.appName instead — it reliably returns the app name.
		const isNonVscodeHost =
			process.env.THEIA_WEBVIEW_EXTERNAL_ENDPOINT ||
			process.env.THEIA_DEFAULT_PLUGINS ||
			!vscode.env.appName.startsWith("Visual Studio Code")
		if (isNonVscodeHost) {
			const stateManager = StateManager.get()
			const currentMode = stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
			if (!currentMode || currentMode === "vscodeTerminal") {
				stateManager.setGlobalState("vscodeTerminalExecutionMode", "backgroundExec")
				Logger.log(
					`[Cline] Non-VS-Code host detected (appName="${vscode.env.appName}"), setting terminal mode to backgroundExec`,
				)
			}
		}
	} catch (error) {
		Logger.error("[Cline] CRITICAL: Failed to initialize StateManager:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Failed to initialize storage. Please check logs for details or try restarting the client.",
		})
	}

	// =============== External services ===============
	await ErrorService.initialize()
	// Initialize OpenAI Codex OAuth manager with extension context for secrets storage
	openAiCodexOAuthManager.initialize(context)
	// Initialize PostHog client provider (skip in self-hosted mode)
	if (!ClineEndpoint.isSelfHosted()) {
		PostHogClientProvider.getInstance()
	}

	// =============== Webview services ===============
	const webview = HostProvider.get().createWebviewProvider()
	// Initialize banner service (TEMPORARILY DISABLED - not fetching banners to prevent API hammering)
	BannerService.initialize(webview.controller)

	const stateManager = StateManager.get()
	// Non-blocking announcement check and display
	showVersionUpdateAnnouncement(context)
	// Check if this workspace was opened from worktree quick launch
	await checkWorktreeAutoOpen(stateManager)

	// =============== Background sync and cleanup tasks ===============
	// Use remote config blobStoreConfig if available, otherwise fall back to env vars
	const blobStoreSettings = stateManager.getRemoteConfigSettings()?.blobStoreConfig ?? getBlobStoreSettingsFromEnv()
	syncWorker().init({ ...blobStoreSettings, userDistinctId: getDistinctId() })
	// Clean up old temp files in background (non-blocking) and start periodic cleanup every 24 hours
	ClineTempManager.startPeriodicCleanup()
	// Clean up orphaned file context warnings (startup cleanup)
	FileContextTracker.cleanupOrphanedWarnings(context)

	telemetryService.captureExtensionActivated()

	// Auto-open Cline panel on startup (GeologyIDE only).
	// The extension is registered in the secondary sidebar via package.json,
	// but we need to explicitly focus it to ensure the panel is visible on load.
	if (!vscode.env.appName.startsWith("Visual Studio Code")) {
		setTimeout(async () => {
			try {
				await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)
			} catch (e) {
				// View may not be ready yet — safe to ignore
			}
		}, 1500)
	}

	return webview
}

async function showVersionUpdateAnnouncement(context: vscode.ExtensionContext) {
	// Version checking for autoupdate notification
	const currentVersion = ExtensionRegistryInfo.version
	const previousVersion = context.globalState.get<string>("clineVersion")
	// Perform post-update actions if necessary
	try {
		if (!previousVersion || currentVersion !== previousVersion) {
			Logger.log(`Cline version changed: ${previousVersion} -> ${currentVersion}. First run or update detected.`)

			// Check if there's a new announcement to show
			const lastShownAnnouncementId = context.globalState.get<string>("lastShownAnnouncementId")
			const latestAnnouncementId = getLatestAnnouncementId()

			if (lastShownAnnouncementId !== latestAnnouncementId) {
				// Show notification when there's a new announcement (major/minor updates or fresh installs)
				const message = previousVersion
					? `Geology Agent has been updated to v${currentVersion}`
					: `Welcome to Geology Agent v${currentVersion}`
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message,
				})
			}
			// Always update the main version tracker for the next launch.
			await context.globalState.update("clineVersion", currentVersion)
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		Logger.error(`Error during post-update actions: ${errorMessage}, Stack trace: ${error.stack}`)
	}
}

/**
 * Checks if this workspace was opened from the worktree quick launch button.
 * If so, opens the Cline sidebar and clears the state.
 */
async function checkWorktreeAutoOpen(stateManager: StateManager): Promise<void> {
	try {
		// Read directly from globalState (not StateManager cache) since this may have been
		// set by another window right before this one opened
		const worktreeAutoOpenPath = stateManager.getGlobalStateKey("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		// Get current workspace path
		const workspacePaths = (await HostProvider.workspace.getWorkspacePaths({})).paths
		if (workspacePaths.length === 0) {
			return
		}

		const currentPath = workspacePaths[0]

		// Check if current workspace matches the worktree path
		if (arePathsEqual(currentPath, worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			stateManager.setGlobalState("worktreeAutoOpenPath", undefined)
			// Open the Cline sidebar
			await HostProvider.workspace.openClineSidebarPanel({})
		}
	} catch (error) {
		Logger.error("Error checking worktree auto-open", error)
	}
}

/**
 * Configure OpenRouter API from the OPENROUTER_API_KEY environment variable.
 * This allows pre-configuring the extension with an API key without user
 * interaction (e.g. `docker run -e OPENROUTER_API_KEY=...`).
 *
 * Non-destructive: once the user has completed setup with a different
 * provider, their choice is never overridden by the env var. The stored key
 * is refreshed only when OpenRouter is (or is about to become) the active
 * provider and the env value changed.
 */
async function configureOpenRouterFromEnv(context: vscode.ExtensionContext): Promise<void> {
	const envApiKey = process.env.OPENROUTER_API_KEY
	if (!envApiKey) {
		return
	}

	try {
		const stateManager = StateManager.get()

		// Read welcomeViewCompleted directly from context.globalState — the
		// StateManager cache may not reflect it yet at this point in startup.
		const setupCompleted = context.globalState.get<boolean>("welcomeViewCompleted")
		const existingProvider = stateManager.getGlobalSettingsKey("actModeApiProvider")
		if (setupCompleted && existingProvider && existingProvider !== "openrouter") {
			Logger.log("[Cline] OPENROUTER_API_KEY set but another provider is configured; keeping the user's choice")
			return
		}

		const existingKey = stateManager.getSecretKey("openRouterApiKey")
		if (existingKey && existingKey === envApiKey && setupCompleted) {
			Logger.log("[Cline] OpenRouter API key already configured and matches env, skipping")
			return
		}
		if (existingKey && existingKey !== envApiKey) {
			Logger.log("[Cline] OpenRouter API key differs from env (key rotation), updating")
		}

		Logger.log("[Cline] Configuring OpenRouter from environment variable")

		// Set the API key and provider
		stateManager.setSecret("openRouterApiKey", envApiKey)
		stateManager.setGlobalState("planModeApiProvider", "openrouter")
		stateManager.setGlobalState("actModeApiProvider", "openrouter")

		// Set default model for both act and plan modes if not already set
		const actModelId = stateManager.getGlobalSettingsKey("actModeOpenRouterModelId")
		const planModelId = stateManager.getGlobalSettingsKey("planModeOpenRouterModelId")

		if (!actModelId) {
			stateManager.setGlobalState("actModeOpenRouterModelId", openRouterDefaultModelId)
		}
		if (!planModelId) {
			stateManager.setGlobalState("planModeOpenRouterModelId", openRouterDefaultModelId)
		}

		// Mark welcome view as completed to skip the setup wizard.
		// Write DIRECTLY to context.globalState to prevent race with
		// migrateWelcomeViewCompleted() which reads from context.globalState
		// and may overwrite StateManager's cached value before it's flushed.
		stateManager.setGlobalState("welcomeViewCompleted", true)
		await context.globalState.update("welcomeViewCompleted", true)

		// Flush state to disk immediately to ensure it's persisted
		await stateManager.flushPendingState()

		Logger.log("[Cline] OpenRouter configured successfully from environment")
	} catch (error) {
		Logger.error("[Cline] Failed to configure OpenRouter from environment:", error)
	}
}

/**
 * Performs cleanup when Cline is deactivated that is common to all platforms.
 */
export async function tearDown(): Promise<void> {
	// Clean up audio recording service to ensure no orphaned processes
	audioRecordingService.cleanup()

	PostHogClientProvider.getInstance().dispose()
	telemetryService.dispose()
	ErrorService.get().dispose()
	featureFlagsService.dispose()
	// Dispose all webview instances
	await WebviewProvider.disposeAllInstances()
	syncWorker().dispose()
	clearOnboardingModelsCache()

	// Kill any running hook processes to prevent zombies
	await HookProcessRegistry.terminateAll()
	// Clean up hook discovery cache
	HookDiscoveryCache.getInstance().dispose()
	// Stop periodic temp file cleanup
	ClineTempManager.stopPeriodicCleanup()

	// Clean up test mode
	cleanupTestMode()
}
