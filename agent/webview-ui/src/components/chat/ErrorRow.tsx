import { ClineMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import CreditLimitError from "@/components/chat/CreditLimitError"
import { Button } from "@/components/ui/button"
import { useClineAuth, useClineSignIn } from "@/context/ClineAuthContext"
import { ClineError, ClineErrorType } from "../../../../src/services/error/ClineError"

const _errorColor = "var(--vscode-errorForeground)"

interface ErrorRowProps {
	message: ClineMessage
	errorType: "error" | "mistake_limit_reached" | "diff_error" | "clineignore_error"
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
}

const ErrorRow = memo(({ message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage }: ErrorRowProps) => {
	const { clineUser } = useClineAuth()
	const rawApiError = apiRequestFailedMessage || apiReqStreamingFailedMessage

	const { isLoginLoading, handleSignIn } = useClineSignIn()

	const renderErrorContent = () => {
		switch (errorType) {
			case "error":
			case "mistake_limit_reached":
				// Handle API request errors with special error parsing
				if (rawApiError) {
					// FIXME: ClineError parsing should not be applied to non-Cline providers, but it seems we're using clineErrorMessage below in the default error display
					const clineError = ClineError.parse(rawApiError)
					const errorMessage = clineError?._error?.message || clineError?.message || rawApiError
					const requestId = clineError?._error?.request_id
					const providerId = clineError?.providerId || clineError?._error?.providerId
					const isClineProvider = providerId === "cline"
					const errorCode = clineError?._error?.code

					if (clineError?.isErrorType(ClineErrorType.Balance)) {
						const errorDetails = clineError._error?.details
						return (
							<CreditLimitError
								buyCreditsUrl={errorDetails?.buy_credits_url}
								currentBalance={errorDetails?.current_balance}
								message={errorDetails?.message}
								totalPromotions={errorDetails?.total_promotions}
								totalSpent={errorDetails?.total_spent}
							/>
						)
					}

					if (clineError?.isErrorType(ClineErrorType.RateLimit)) {
						return (
							<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere">
								{errorMessage}
								{requestId && <div>Request ID: {requestId}</div>}
							</p>
						)
					}

					return (
						<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere flex flex-col gap-3">
							<header>{errorMessage}</header>

							{/* Windows Powershell Issue */}
							{errorMessage?.toLowerCase()?.includes("powershell") && (
								<div>
									It seems like you're having Windows PowerShell issues, please see this{" "}
									<a
										className="underline text-inherit"
										href="https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22">
										troubleshooting guide
									</a>
									.
								</div>
							)}

							{/* Technical details — uncomment to show collapsible debug info */}
							{/* {(requestId || errorCode || (errorMessage !== rawApiError && rawApiError)) && (
								<details className="text-xs text-description">
									<summary className="cursor-pointer">Technical details</summary>
									<div className="mt-1 flex flex-col gap-1">
										{providerId && <div>Provider: {providerId}</div>}
										{errorCode && <div>Code: {errorCode}</div>}
										{requestId && <div>Request ID: {requestId}</div>}
									</div>
								</details>
							)} */}

							<div>
								{isClineProvider && !clineUser ? (
									<Button className="w-full mb-4" disabled={isLoginLoading} onClick={handleSignIn}>
										Sign in to Cline
										{isLoginLoading && (
											<span className="ml-1 animate-spin">
												<span className="codicon codicon-refresh"></span>
											</span>
										)}
									</Button>
								) : (
									<span className="mb-4 text-description">(Click "Retry" below)</span>
								)}
							</div>
						</p>
					)
				}

				// Regular error message
				return <p className="m-0 mt-0 whitespace-pre-wrap text-error wrap-anywhere">{message.text}</p>

			case "diff_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>The model used search patterns that don't match anything in the file. Retrying...</div>
					</div>
				)

			case "clineignore_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>
							Cline tried to access <code>{message.text}</code> which is blocked by the <code>.clineignore</code>
							file.
						</div>
					</div>
				)

			default:
				return null
		}
	}

	// For diff_error and clineignore_error, we don't show the header separately
	if (errorType === "diff_error" || errorType === "clineignore_error") {
		return renderErrorContent()
	}

	// For other error types, show header + content
	return renderErrorContent()
})

export default ErrorRow
