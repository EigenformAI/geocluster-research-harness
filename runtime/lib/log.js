/** Minimal structured-ish logger: one line per event, ISO timestamp, component prefix. */
export function createLogger(component, sink = console) {
	const line = (level, message, extra) => {
		const suffix = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`
		return `${new Date().toISOString()} ${level} [${component}] ${message}${suffix}`
	}
	return {
		info: (message, extra) => sink.log(line("INFO", message, extra)),
		warn: (message, extra) => sink.warn(line("WARN", message, extra)),
		error: (message, extra) => sink.error(line("ERROR", message, extra)),
		child: (name) => createLogger(`${component}:${name}`, sink),
	}
}
