#!/usr/bin/env python3
"""Create-only native project imports and exports, using the session owner lock."""
import argparse
import os
from pathlib import Path
import sys
import tempfile

from setup_common import (Docker, SetupError, import_source, load_profile,
                          prepare_import, validate_destination, validate_project, validate_storage)
from setup_transfer import safe_extract


class Cancelled(Exception):
    pass


def prompt(message, default=None, help_text='Close GeoCluster with /exit before moving project files.'):
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SetupError('Missing a required argument: ' + message, 'usage')
    while True:
        try:
            value = input(message + (f' [{default}]' if default is not None else '') + ': ').strip()
        except EOFError:
            raise Cancelled() from None
        if value.lower() in ('q', 'b'):
            raise Cancelled()
        if value == '?':
            print(help_text)
            continue
        if value:
            return value
        if default is not None:
            return default
        print('Enter a value, or type b to choose another option.')


def confirm(message, help_text='Only the project copy changes. Original files stay unchanged.'):
    while True:
        answer = prompt(message + ' [Y/n]', 'y', help_text).lower()
        if answer in ('y', 'yes'):
            return True
        if answer in ('n', 'no'):
            return False
        print('Enter yes or no, ? for help, b to go back, or q to quit.')


def parser():
    result = argparse.ArgumentParser(description=__doc__, epilog='By default use the saved setup. For explicit settings provide --project and exactly one storage option; do not mix saved and explicit choices. Run /exit inside GeoCluster before transfers. Imports never merge or replace. Exports require other host editors to stop; they are not filesystem snapshots.')
    result.add_argument('action', choices=('import', 'export'))
    result.add_argument('source', nargs='?', help='Client source folder (import) or project path (export).')
    result.add_argument('destination', nargs='?', help='New client destination folder (export only).')
    result.add_argument('--into', help='New project child folder for import.')
    result.add_argument('--allow-restricted', action='store_true', help='Authorize GeoCluster service-account access to private files in the imported copy.')
    result.add_argument('--image', help='Installed compatible image for explicit storage (default: geocluster-runtime:latest).')
    storage = result.add_mutually_exclusive_group()
    storage.add_argument('--workspace-volume')
    storage.add_argument('--workspace-root')
    result.add_argument('--project')
    return result


def select(docker, args):
    explicit = any((args.image, args.workspace_volume, args.workspace_root, args.project))
    if explicit:
        if not args.project or not (args.workspace_volume or args.workspace_root):
            raise SetupError('Explicit transfers require --project and --workspace-volume or --workspace-root. Saved and explicit selections cannot be mixed.', 'usage')
        project = validate_project(args.project)
        storage = {'kind': 'volume', 'name': args.workspace_volume} if args.workspace_volume else {'kind': 'bind', 'path': str(Path(args.workspace_root).absolute())}
        validate_storage(storage)
        image = docker.image(args.image or 'geocluster-runtime:latest')
        return storage, project, image['id']
    profile = load_profile()
    if profile is None:
        raise SetupError("Let's choose a project. Run ./scripts/setup.sh to get started, or provide explicit storage and --project.")
    try:
        docker.check(profile['docker']['fingerprint'])
    except SetupError as error:
        raise SetupError("This project uses a different Docker connection. Run ./scripts/setup.sh to choose where you'd like to work.", 'docker_changed') from error
    image = docker.image(profile['image']['id'])
    return profile['storage'], profile['project'], image['id']


def fresh_name(name, names):
    index = 2
    while f'{name}-{index}' in names:
        index += 1
    return f'{name}-{index}'


def import_files(docker, storage, project, image_id, args):
    if args.destination:
        raise SetupError('Import accepts one source folder. Use --into NAME for the project destination.', 'usage')
    source = args.source or prompt('Source folder on this computer')
    source = str(Path(source).expanduser().absolute())
    manifest, restricted = prepare_import(source)
    names = {entry['path'] for entry in manifest['entries']}
    if any('.opencode' in Path(name).parts or name.endswith('opencode.json') or '.claude' in Path(name).parts for name in names):
        print('This folder includes configuration or plugins that GeoCluster can run. Use a source you trust.')
    allow = args.allow_restricted
    if restricted and not allow:
        print('These files are private to your account:\n  ' + '\n  '.join(restricted))
        print("We'll give GeoCluster's tools access to the project copy.")
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise SetupError('Private files need explicit copy access: review the paths and pass --allow-restricted, or use the interactive command.', 'permission_required')
        if not confirm('Include these files?'):
            raise Cancelled()
        allow = True
    destination = args.into or (prompt('Folder name inside the project', Path(source).name) if sys.stdin.isatty() and sys.stdout.isatty() else Path(source).name)
    validate_destination(destination)
    info = docker.inspect(storage, project, image_id)
    if not info.get('exists'):
        raise SetupError(f"We couldn't find {project}. Run ./scripts/setup.sh to locate it or create a new project.", 'project_missing')
    children = info.get('children', [])
    if destination in children:
        suggestion = fresh_name(destination, children)
        if args.into or not sys.stdin.isatty() or not sys.stdout.isatty():
            raise SetupError(f'{destination} already exists. Choose a fresh --into name, such as {suggestion}.', 'destination_exists')
        if not confirm(f'There is already a folder named {destination}. Use {suggestion}?'):
            destination = prompt('Another folder name inside the project')
        else:
            destination = suggestion
        validate_destination(destination)
    if docker.label != 'local Linux Docker':
        print(f"We'll copy this folder to {docker.label}.")
    print(f'Copying {source} into {project}/{destination}...', flush=True)
    # Reuse the reviewed manifest. Do not silently approve a newly changed source.
    result = import_source(docker, storage, image_id, project, destination, source, allow, manifest=manifest)
    print(f"Your data is ready in {project}/{result.get('destination', destination)}/. Originals stay unchanged.")


def choose_export(docker, storage, project, image_id):
    offset = 0
    while True:
        result = docker.operation(storage, image_id, ['list', '--project', project, '--offset', str(offset), '--limit', '20'])
        paths = result.get('paths', [])
        if not paths:
            return prompt('Project folder to export', '.', 'Enter an exact ordinary project path. Use . for ordinary project content. Private state cannot be exported.')
        print(f'Folders in {project}:')
        for index, path in enumerate(paths, 1):
            print(f'{index}. {path}')
        more = result.get('hasMore', False)
        answer = prompt('Choose a number or enter an exact project path' + (', or n for next page' if more else ''), '1')
        if answer == 'n' and more:
            offset += len(paths)
            continue
        if answer.isdigit() and 1 <= int(answer) <= len(paths):
            return paths[int(answer) - 1]
        if answer.isdigit():
            print('Enter one of the displayed numbers or an exact project path.')
            continue
        return answer


def export_files(docker, storage, project, image_id, args):
    if args.into or args.allow_restricted:
        raise SetupError('--into and --allow-restricted are import options.', 'usage')
    source = args.source or choose_export(docker, storage, project, image_id)
    destination = args.destination or prompt('New output folder on this computer', str(Path.cwd() / (Path(source).name + '-export' if source != '.' else project + '-export')))
    destination = Path(destination).expanduser().absolute()
    if os.path.lexists(destination):
        raise SetupError(f'{destination} already exists. Choose a new output folder; exports never replace files.')
    if not destination.parent.is_dir():
        raise SetupError(f'Output parent {destination.parent} must already exist.')
    print('Stop other project editors before exporting. This copy is not a filesystem snapshot.')
    print(f'Exporting {project}/{source} to {destination}...', flush=True)
    with tempfile.TemporaryFile() as archive:
        docker.operation(storage, image_id, ['export', '--project', project, '--path', source], output_file=archive)
        archive.seek(0)
        safe_extract(archive, str(destination.parent), destination.name, service_ownership=False)
    print(f'Export ready: {destination}')


def main(argv=None):
    args = parser().parse_args(argv)
    # Diagnose omitted values before touching Docker when unattended.
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        if not args.source:
            raise SetupError(f'{args.action} needs a source argument when not running in a terminal.', 'usage')
        if args.action == 'export' and not args.destination:
            raise SetupError('export needs a destination argument when not running in a terminal.', 'usage')
    docker = Docker()
    storage, project, image_id = select(docker, args)
    if args.action == 'import':
        import_files(docker, storage, project, image_id, args)
    else:
        export_files(docker, storage, project, image_id, args)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Cancelled, KeyboardInterrupt):
        print('File transfer cancelled. Existing project files stay where they are.', file=sys.stderr)
        sys.exit(130)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2 if not isinstance(error, SetupError) or error.code == 'usage' else 1)
