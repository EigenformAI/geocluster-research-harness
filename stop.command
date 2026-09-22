#!/usr/bin/env bash
# Double-click entry point for macOS Finder — delegates to stop.sh so Terminal
# opens, runs the real script, and stays open to show the result.
cd "$(dirname "$0")"
exec ./stop.sh
