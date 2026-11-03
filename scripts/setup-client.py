#!/usr/bin/env python3
"""Launch only the workspace explicitly saved by guided setup."""
import shlex
import sys
from setup_common import SetupError, explicit_command, launch, load_profile


def main():
    if sys.argv[1:] in (['--help'], ['-h']):
        print('Usage: ./scripts/tui.sh\n\nOpen the workspace saved by ./scripts/setup.sh. No launch overrides are accepted.\nFor custom settings, use ./scripts/run-runtime-tui.sh --help.')
        profile = load_profile()
        if profile:
            print('\nExplicit saved launch:\n  ' + shlex.join(explicit_command(profile)))
        return 0
    if sys.argv[1:]:
        raise SetupError('Saved launch does not accept options. Use ./scripts/run-runtime-tui.sh --help for an explicit launch.', 'usage')
    profile = load_profile()
    if profile is None:
        raise SetupError("Let's set up your workspace. Run ./scripts/setup.sh to get started.")
    return launch(profile)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (SetupError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2 if isinstance(error, SetupError) and error.code == 'usage' else 1)
