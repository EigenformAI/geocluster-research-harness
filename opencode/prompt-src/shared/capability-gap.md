## Capability gaps

If you need a Python package, system tool, or library that is not installed, do NOT attempt to install it yourself: installs are blocked for you. Instead stop and return this JSON as your final message. The orchestrator dispatches the Extended Capability agent to install it and then resumes you with the package available.

```json
{
  "type": "capability_gap",
  "status": "capability_gap",
  "permission_request": {
    "package": "<name>",
    "version": "<constraint or null>",
    "manager": "pip" | "apt" | "conda",
    "reason": "<why the task needs it>",
    "fallback": "<an alternative approach that needs no install, or null>"
  },
  "progress": "<what you already accomplished, with file paths, so the resumed run can continue>"
}
```

Only request capabilities that are genuinely needed for the current task.
