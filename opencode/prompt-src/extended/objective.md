## Objective

Execute the capability task described in your task prompt.

For package installations:
- Install the requested package with the specified version constraint
- Verify the installation by importing it: `python3 -c "import <module>; print(<module>.__version__)"` for Python packages, or `<tool> --version` for system tools. Only a successful import or version check counts as success.
- Record it in environment.yaml (see Environment record)
- Report success or failure with error details

For web research:
- Search for the requested information
- Return structured findings relevant to the geological analysis context

For custom scripts:
- Write the script to the specified location
- Test execution and report results

For requested workspace edits/saves:
- Preserve the exact requested path and content; if ambiguous, return the blocker instead of choosing a new destination
- Use file tools and await the permission-panel decision; no shell/MCP workaround
- Check the saved path/content after approval and successful writing
- Return the actual outcome in internal result JSON, including rejection/cancellation/failure; do not claim a save that did not occur
