#!/usr/bin/env python3
"""Delegate the retired Compose launcher to the native runtime launcher."""
import os
from pathlib import Path
import sys


def main(argv=None):
    launcher = Path(__file__).resolve().with_name("run-runtime-tui.sh")
    args = sys.argv[1:] if argv is None else argv
    os.execvp("bash", ["bash", str(launcher), *args])


if __name__ == "__main__":
    main()
