#!/usr/bin/env python3
"""Interactive, task-approved setup for a native GeoCluster project."""
import copy
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap


IMAGE = 'geocluster-runtime:latest'
VOLUME = 'geocluster-native-workspace'
PROCESSOR = 'https://github.com/EigenformAI/geocluster-data-preprocessing-service.git'
PUBLIC = 'https://github.com/EigenformAI/geocluster-research-harness/blob/'


class Back(Exception):
    pass


class Cancel(Exception):
    pass


class ImageOptions(Exception):
    pass


class ImageSelection(Exception):
    def __init__(self, mode):
        self.mode = mode


class StorageEdited(Exception):
    pass


class Wizard:
    def __init__(self, support, input_stream=None, output_stream=None):
        self.support = support
        self.input = input_stream or sys.stdin
        self.output = output_stream or sys.stdout
        self.repo = support.REPO
        self.plan = {'version': 1, 'image': None, 'docker': None, 'storage': None,
                     'project': None, 'starter': {'kind': 'samples', 'destination': None},
                     'operation': None}
        self.saved = None
        self.docker = None
        self.inspection = {}
        self.source = None
        self.manifest = None
        self.allow_restricted = False
        self.host_plan = None
        self.build_source = None
        self.fresh_source = False
        self.image_cause = ''
        self.started = False
        self.active = None
        self.completed = []
        self.copy_ready = False
        self.resume_operation = False
        self.sample_verified = False
        self.prepared = False
        self.resume = False
        self.reviewing = False
        self.review_route = False
        self.stage = 1

    def say(self, text=''):
        # Paths and command lines stay intact; explanatory prose wraps naturally.
        width = max(40, shutil.get_terminal_size((80, 24)).columns)
        for line in str(text).split('\n'):
            if line.startswith((' ', '\t')) or '://' in line or '/' in line or len(line) <= width:
                print(line, file=self.output)
            else:
                print(textwrap.fill(line, width=width), file=self.output)
        self.output.flush()

    def heading(self, number, title):
        self.say(f'\nStep {number} of 7: {title}\n')

    def ask(self, prompt, *, default=None, help_text='', expected='a value', help_action=None):
        while True:
            print(prompt + ' ', end='', file=self.output, flush=True)
            line = self.input.readline()
            if line == '':
                raise Cancel()
            value = line.strip()
            control = value.lower()
            if control == 'q':
                raise Cancel()
            if control == 'b':
                raise Back()
            if control == '?':
                self.say(help_text or 'Press Enter to keep the displayed default. Type b to go back or q to leave setup.')
                if help_action:
                    help_action()
                continue
            if value:
                return value
            if default is not None:
                return default
            self.say(f'Enter {expected}, or type b to choose another option.')

    def confirm(self, prompt, *, help_text='', help_action=None):
        while True:
            value = self.ask(prompt.rstrip(':? ') + '? [Y/n]:', default='y',
                             help_text=help_text, help_action=help_action)
            if value.lower() in ('y', 'yes'):
                self.say('Selected: Yes')
                return True
            if value.lower() in ('n', 'no'):
                self.say('Selected: No')
                return False
            self.say('Enter y or n, or type ? for help, b to go back, or q to quit.')

    def menu(self, items, default=1, *, help_text='', help_action=None):
        for index, label in enumerate(items, 1):
            self.say(f'{index}. {label}')
        while True:
            value = self.ask(f'Choose [{default}]:', default=str(default),
                             help_text=help_text, help_action=help_action)
            if value.isascii() and value.isdecimal() and 1 <= int(value) <= len(items):
                self.say(f'Selected: {items[int(value) - 1].split(chr(10))[0]}')
                return int(value)
            self.say('Enter one of the displayed numbers, or type ? for help, b to go back, or q to quit.')

    def error(self, message, code='failed'):
        return self.support.SetupError(message, code)

    def check(self):
        self.docker.check(self.plan['docker']['fingerprint'])

    def pending(self, stage):
        value = copy.deepcopy(self.plan)
        value.update(stage=stage, allowRestricted=self.allow_restricted, completed=self.completed[:])
        self.support.save_pending(value)

    def mark(self, description):
        if description not in self.completed:
            self.completed.append(description)

    def start(self, action, stage):
        self.pending(stage)
        self.started = True
        self.active = action

    def cancel(self):
        if not self.started:
            self.say('\nExiting setup. No changes were made.')
        else:
            self.say('\nExiting setup.')
            if self.active:
                self.say(f'Interrupted: {self.active}.')
            self.say('Completed: ' + (', '.join(self.completed) or 'no completed tasks confirmed') + '.')
            self.say('\nYou can pick this up later with ./scripts/setup.sh.')
        return 130

    def tools_url(self, tool):
        return {'Bash': 'https://www.gnu.org/software/bash/', 'Git': 'https://git-scm.com/downloads',
                'Python 3': 'https://www.python.org/downloads/',
                'Docker': 'https://docs.docker.com/get-started/get-docker/'}[tool]

    def check_tools(self):
        if os.geteuid() == 0 or os.getuid() != os.geteuid():
            raise self.error('Run guided setup as your ordinary account, not root. Administrator access is requested only for an approved host workspace folder.')
        for tool, executable in [('Bash', 'bash'), ('Git', 'git'), ('Python 3', 'python3'), ('Docker', 'docker')]:
            if not shutil.which(executable):
                raise self.error(f'Install {tool} to continue setup.\n\n{self.tools_url(tool)}\nThen run this guide again:\n  ./scripts/setup.sh')

    def read_command(self, args, *, cwd=None):
        result = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
        if result.returncode:
            # Only use this for local Git/Buildx commands, never endpoint metadata.
            raise self.error((result.stderr or result.stdout or f'{args[0]} failed').strip())
        return result.stdout.strip()

    def public_guide(self, name):
        try:
            revision = self.read_command(['git', '-C', str(self.repo), 'rev-parse', 'HEAD'])
        except self.support.SetupError:
            revision = 'main'
        return PUBLIC + revision + '/docs/' + name

    def custom_guide(self):
        return 'Custom installation guide: ' + self.public_guide('CUSTOM_INSTALLATION.md')

    def opening(self):
        self.say("Set up GeoCluster\n\nLet's get your first project ready. We'll prepare GeoCluster, choose a home\nfor your files, and help you start with sample data or your own work.\n\nKeep the recommended choices to try GeoCluster with Wattle Creek sample data.\nYou'll connect your model provider when GeoCluster opens.\n\nPress Enter for the recommended choice, ? for more options, b to go back,\nor q to leave setup.\n")
        self.saved = self.support.load_profile()
        pending = self.support.load_pending()
        if self.saved:
            self.plan = copy.deepcopy(self.saved)
            self.plan['starter'] = {'kind': 'existing', 'destination': None}
            self.say(f"Welcome back. Your saved project is {self.plan['project']}, using {self.storage_description()}.\nPress Enter through the choices to keep this setup.")
        if pending:
            project = pending.get('project')
            self.say(f"\nWelcome back. Let's finish setting up {project}." if project else "\nWelcome back. Let's finish preparing GeoCluster.")
            try:
                restore = self.confirm('Continue with your saved choices', help_text='Continue restores unfinished choices and checks workspace records before copying again. No keeps your last successful settings, or first-run defaults.')
            except Back:
                restore = False
            if restore:
                self.plan = {key: copy.deepcopy(pending.get(key)) for key in self.plan}
                self.allow_restricted = pending.get('allowRestricted', False)
                self.resume = True
                self.stage = max(2, min(6, pending.get('stage', 2)))

    def computer(self):
        self.heading(1, 'Check this computer')
        self.say('Checking the required tools and Docker connection...\n')
        self.check_tools()
        self.docker = self.support.Docker()
        self.docker.check()
        previous = self.plan.get('docker')
        if previous and previous['fingerprint'] != self.docker.fingerprint:
            self.say('Your saved choices use a different Docker connection. Workspace names on this host may refer to different files.')
            if not self.confirm('Use this Docker host for your selected choices', help_text=f'Current connection: {self.docker.label}. Setup never changes Docker contexts. Choose No to select a different connection before running setup again.'):
                raise Cancel()
            self.resume = False
            self.stage = 2
            self.plan['operation'] = None
        self.plan['docker'] = {'fingerprint': self.docker.fingerprint, 'label': self.docker.label}
        self.say(f'Bash, Git, and Python 3 are ready.\nDocker is running: {self.docker.label}\n\nEverything looks ready. Let\'s prepare GeoCluster.')
        if not self.docker.local_host:
            self.say(f"\nYou're connected to {self.docker.label}.\nYour workspace and copied data will live on that Docker host.")

    def check_builder(self):
        self.check()
        try:
            self.read_command(['docker', 'buildx', 'version'])
            output = self.read_command(['docker', 'buildx', 'inspect'])
        except self.support.SetupError:
            raise self.error('A working Docker Buildx builder is needed to build GeoCluster.\nhttps://docs.docker.com/build/install-buildx/\nStart Docker, or select a working Linux x64 builder.') from None
        platforms = re.findall(r'^\s*Platforms:\s*(.+)$', output, flags=re.MULTILINE)
        if not platforms or not all(re.search(r'\blinux/amd64(?:\*|\b)', value) for value in platforms):
            detected = ', '.join(platforms) or 'no Linux x64 platform'
            raise self.error(f'GeoCluster needs a Linux x64 Docker environment.\nYour selected builder reports {detected}.\n\nChoose a Linux x64 Docker host, then run ./scripts/setup.sh again.')
        # The active Docker daemon has already been required to be native amd64.
        self.say('Buildx builder is ready for linux/amd64.')

    def validate_source(self, path):
        path = Path(path).expanduser().absolute()
        # The validator writes only a disposable output, never the source checkout.
        temporary_base = '/tmp/opencode' if Path('/tmp/opencode').is_dir() else None
        with tempfile.TemporaryDirectory(prefix='setup-release-check-', dir=temporary_base) as output:
            self.read_command([sys.executable, str(self.repo / 'scripts/preprocessing-bundle.py'),
                               '--source', str(path), '--output', output, '--mode', 'release'])
        status = self.read_command(['git', '-C', str(path), 'submodule', 'status', '--recursive'])
        if any(line.startswith(('-', '+', 'U')) for line in status.splitlines()):
            raise self.error('Processor submodules must be initialized at their pinned revisions.')
        dirty = self.read_command(['git', '-C', str(path), 'submodule', 'foreach', '--recursive', '--quiet',
                                   'git status --porcelain --untracked-files=all'])
        if dirty:
            raise self.error('Processor submodules contain local changes.')
        return path

    def source_cache(self):
        pin = json.loads((self.repo / 'scripts/preprocessing-release.json').read_text())
        cache_home = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache').expanduser().absolute()
        return cache_home / 'geocluster/processor' / pin['sourceRevision']

    def source_plan(self):
        original = self.source_cache()
        self.fresh_source = False
        if original.exists() or original.is_symlink():
            try:
                if original.is_symlink():
                    raise self.error('The cached checkout is a symbolic link.')
                return self.validate_source(original)
            except self.support.SetupError:
                number = 2
                while True:
                    candidate = original.with_name(original.name + f'-{number}')
                    if not candidate.exists() and not candidate.is_symlink():
                        self.fresh_source = True
                        self.say(f"We'll use a fresh build-source copy at {candidate}.")
                        return candidate
                    number += 1
        return original

    def build_help(self):
        image = self.plan.get('image') or {}
        source = self.build_source or self.source_cache()
        self.say(f"GeoCluster's image build needs the pinned document processor source, even with extraction off.\nBuild source: {source}\nBuilds use the release validator; existing folders are never reset or cleaned.\nInstalled-image compatibility checks setup support, not release provenance.\nImage ID: {image.get('id', 'not selected')}\n" + (self.image_cause + '\n' if self.image_cause else '') + self.custom_guide())

    def image_options(self):
        self.build_help()
        raise ImageOptions()

    def build_sources(self):
        self.build_help()
        self.say('\nBuild source\n')
        choice = self.menu(['Download the required source (default)', 'Use an existing source folder'],
                           help_text='The release validator checks the pinned revision, clean Git state, and exact production bundle digest. Modified cache folders stay unchanged.')
        if choice == 1:
            self.build_source = self.source_plan()
            raise ImageSelection('build')
        else:
            raise ImageSelection(self.image_alternatives(choice=3))

    def build(self, source):
        self.check()
        # Check unfamiliar harness work before downloading or building anything.
        submodules = self.read_command(['git', '-C', str(self.repo), 'submodule', 'status', '--recursive'])
        if any(line.startswith(('+', 'U')) for line in submodules.splitlines()):
            raise self.error('Harness submodules differ from their pins. Keep local changes and use the custom-installation guide.\n' + self.custom_guide())
        dirty = self.read_command(['git', '-C', str(self.repo), 'submodule', 'foreach', '--recursive', '--quiet',
                                   'git status --porcelain --untracked-files=all'])
        if dirty:
            raise self.error('Harness submodules contain local changes. Keep those changes and use the custom-installation guide.\n' + self.custom_guide())
        source = Path(source)
        if not source.exists():
            self.say('Downloading build sources...')
            pin = json.loads((self.repo / 'scripts/preprocessing-release.json').read_text())
            source.parent.mkdir(parents=True, exist_ok=True)
            # Never clone into or clean an existing checkout. Git fails on races.
            subprocess.run(['git', 'clone', '--no-checkout', PROCESSOR, str(source)], check=True)
            self.check()
            subprocess.run(['git', '-C', str(source), 'checkout', '--detach', pin['sourceRevision']], check=True)
            subprocess.run(['git', '-C', str(source), 'submodule', 'update', '--init', '--recursive'], check=True)
            self.mark('pinned build source downloaded')
            self.pending(2)
        self.validate_source(source)
        self.check()
        # Harness submodule initialization is part of the approved build task.
        if any(line.startswith('-') for line in submodules.splitlines()):
            subprocess.run(['git', '-C', str(self.repo), 'submodule', 'update', '--init', '--recursive'], check=True)
            self.mark('harness submodules prepared')
            self.pending(2)
        self.check()
        self.say('Building GeoCluster...')
        env = dict(os.environ, PREPROCESSING_SOURCE_DIR=str(source), PREPROCESSING_BUILD_MODE='release',
                   IMAGE_NAME='geocluster-runtime', IMAGE_TAG='latest', REGISTRY='')
        # Disallow inherited alternate bundles bypassing the selected source.
        env.pop('PREPROCESSING_BUILD_CONTEXT', None)
        if os.environ.get('NO_COLOR') is not None or os.environ.get('TERM') == 'dumb':
            env['TERM'] = 'dumb'
        args = ['bash', str(self.repo / 'scripts/build-docker.sh')]
        if os.environ.get('NO_COLOR') is not None or os.environ.get('TERM') == 'dumb':
            # Also strip ANSI emitted by Docker or other build subprocesses.
            with subprocess.Popen(args, cwd=self.repo, env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, errors='replace') as process:
                for line in process.stdout:
                    self.output.write(re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line))
                    self.output.flush()
                result = process.wait()
            if result:
                raise subprocess.CalledProcessError(result, args)
        else:
            subprocess.run(args, cwd=self.repo, env=env, check=True)

    def image_alternatives(self, choice=None):
        if choice is None:
            self.say('\nOther ways to prepare GeoCluster\n')
            choice = self.menu(['Build the current GeoCluster image', 'Use another installed image',
                                'Choose an existing build-source folder'], help_text='Choose an installed compatible image, or use the pinned release source. ' + self.custom_guide(), help_action=self.build_sources)
        if choice == 2:
            while True:
                reference = self.ask('Image name or ID:', expected='an image name or ID', help_text='Use a locally installed Linux x64 image with setup protocol 1. Compatibility does not verify release provenance.')
                try:
                    self.check()
                    self.plan['image'] = self.docker.image(reference)
                    return 'image'
                except self.support.SetupError as exc:
                    if getattr(exc, 'code', '').replace('-', '_') in ('identity', 'docker_changed'):
                        raise
                    self.image_cause = str(exc)
                    self.say(f"We couldn't use {reference} on this Docker host. Enter another image, or type b to choose a build.")
        if choice == 3:
            while True:
                path = self.ask('Document processor source folder:', expected='a source folder', help_text='Choose a clean processor Git checkout matching scripts/preprocessing-release.json. ' + self.custom_guide())
                try:
                    self.build_source = self.validate_source(Path(path).expanduser())
                    return 'build'
                except self.support.SetupError as exc:
                    self.say(f'This build needs the source version pinned by GeoCluster.\n{path}: {exc}\n')
                    self.check_builder()
                    if self.confirm('Download the required source and build GeoCluster', help_text='The existing folder stays unchanged. ' + self.custom_guide()):
                        self.build_source = self.source_plan()
                        return 'approved-build'
                    choice = self.menu(['Choose another source folder', 'Development-build guide (manual setup)', 'Return to image choices'], help_text='Development builds use the explicit build script. ' + self.custom_guide())
                    if choice == 2:
                        self.say(self.custom_guide())
                    if choice in (2, 3):
                        return 'alternatives'
        if self.build_source is None:
            self.build_source = self.source_plan()
        return 'build'

    def prepare_image(self):
        self.heading(2, 'Prepare GeoCluster')
        selected = self.plan.get('image')
        try:
            self.check()
            image = self.docker.image(selected['id'] if selected else IMAGE)
            if selected:
                image['reference'] = selected['reference']
            self.plan['image'] = image
            mode = 'image'
            if self.resume:
                if self.stage >= 3:
                    self.started = True
                    self.mark('GeoCluster image prepared')
                return
        except self.support.SetupError as exc:
            self.image_cause = str(exc)
            if getattr(exc, 'code', '').replace('-', '_') in ('identity', 'docker_changed', 'platform'):
                raise
            if selected:
                self.say("Let's prepare the current GeoCluster image for this project.")
            self.plan['image'] = None
            self.build_source = self.source_plan()
            mode = 'build'
        while True:
            try:
                if mode == 'image':
                    image = self.plan['image']
                    self.say(f"GeoCluster is installed and ready to use:\n  {image['reference']}, built {image['created']}\n")
                    if self.confirm('Use this image', help_text='Installed-image compatibility does not establish release provenance. Image ID: ' + image['id'], help_action=self.image_options):
                        return
                    mode = 'alternatives'
                elif mode in ('build', 'approved-build'):
                    self.check_builder()
                    if self.build_source is None:
                        self.build_source = self.source_plan()
                    self.say(f"We'll build GeoCluster using {self.build_source}." if self.build_source.exists() else "We'll download the required source and build GeoCluster.")
                    self.say('The first build can take a while.\n')
                    if mode == 'approved-build' or self.confirm('Build GeoCluster now', help_text='Source retrieval and the build happen now, before choosing a workspace.', help_action=self.image_options):
                        self.plan['image'] = None
                        self.start('building GeoCluster', 2)
                        try:
                            self.build(self.build_source)
                            self.mark('GeoCluster image built')
                            self.check()
                            self.plan['image'] = self.docker.image(IMAGE)
                            self.active = None
                            self.pending(3)
                            self.say("GeoCluster is ready. Let's choose where to keep your work.")
                            return
                        except (self.support.SetupError, subprocess.CalledProcessError, OSError) as exc:
                            if getattr(exc, 'code', '').replace('-', '_') in ('identity', 'docker_changed'):
                                raise
                            self.say(f"We couldn't finish building GeoCluster: {exc}\nThe build output above is available in your terminal scrollback.")
                            if not self.retry('building GeoCluster'):
                                raise self.error('Build not completed. Run ./scripts/setup.sh to try again.')
                            mode = 'build'
                            continue
                    mode = 'alternatives'
                else:
                    mode = self.image_alternatives()
            except (Back, ImageOptions):
                mode = 'alternatives'
            except ImageSelection as selection:
                mode = selection.mode

    def storage_description(self):
        storage = self.plan.get('storage')
        if not storage:
            return 'Docker-managed storage'
        return storage['name'] if storage['kind'] == 'volume' else storage['path']

    def storage_help(self):
        self.say('A workspace keeps projects, conversations, and provider connections together.\nKeep the workspace name to return to the same workspace.\nChoose another name for a separate workspace.')
        storage = self.plan.get('storage') or {}
        name = storage.get('name', VOLUME)
        while True:
            try:
                name = self.ask(f'Workspace name [{name}]:', default=name, help_text='Docker volume names start with a letter or number and use letters, numbers, underscores, hyphens, or periods.')
            except Back:
                return
            if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name):
                break
            self.say(f'Choose a valid Docker workspace name instead of {name}.')
        self.plan['storage'] = {'kind': 'volume', 'name': name}
        self.say(f'Workspace: {name}')
        raise StorageEdited()

    def choose_storage(self):
        self.heading(3, 'Choose where files are kept')
        self.say('Your workspace keeps projects, results, conversations, and provider connections together.\n')
        storage = self.plan.get('storage') or {}
        default = 2 if storage.get('kind') == 'bind' else 1
        while True:
            try:
                choice = self.menu(['Docker-managed storage (recommended)\n   Let GeoCluster manage storage. Use import and export commands to move files\n   between your computer and the workspace.',
                                    'A folder on this computer\n   Browse project files directly. Setup and some file operations use\n   administrator access. Available with local Linux Docker.'], default, help_text='You can change the Docker-managed workspace name here.', help_action=self.storage_help)
            except StorageEdited:
                default = 1
                continue
            self.check()
            if choice == 1:
                current = self.plan.get('storage') or {}
                self.plan['storage'] = {'kind': 'volume', 'name': current.get('name', VOLUME)}
                name = self.plan['storage']['name']
                if self.docker.volume_exists(name):
                    self.say(f'Using existing workspace: {name}')
                self.say(f'Workspace: {name}')
                self.host_plan = None
                return
            if not self.docker.local_host:
                self.say("This Docker connection doesn't support guided setup of a local folder.\nDocker-managed storage works here.\n")
                if self.confirm('Use Docker-managed storage', help_text='Guided host folders need a local rootful Linux daemon on the default Unix socket, without Desktop or user namespace remapping. ' + self.custom_guide()):
                    self.plan['storage'] = {'kind': 'volume', 'name': VOLUME}
                    self.say(f'Workspace: {VOLUME}')
                    return
                self.say(self.custom_guide())
                continue
            base = self.support.allowed_host_base()
            suggested = storage.get('path', str(base / 'default'))
            self.say(f"We'll create a dedicated workspace with room for your projects.\nThe suggested location is {suggested}.\n")
            try:
                while True:
                    value = self.ask(f'Workspace folder [{suggested}]:', default=suggested,
                                     help_text=f'Each project gets a folder inside this workspace.\nGeoCluster also keeps conversations and provider connections here.\n\nAutomatic folder creation is available under {base}.\nTo use another location, choose an existing prepared workspace.\nContainer-owned files need administrator access for some host operations.')
                    path = Path(value).expanduser().absolute()
                    try:
                        plan = self.support.host_root_plan(path)
                        self.host_plan = plan
                        self.plan['storage'] = {'kind': 'bind', 'path': str(path)}
                        self.say(f'Workspace: {path}')
                        return
                    except self.support.SetupError as exc:
                        self.say(f"We couldn't use {path}: {exc}\nChoose another dedicated workspace folder, or type b to return.")
            except Back:
                continue

    def inspect(self):
        self.check()
        self.inspection = self.docker.inspect(self.plan['storage'], self.plan['project'], self.plan['image']['id'])
        return self.inspection

    def choose_project(self):
        self.heading(4, 'Name the project')
        self.say('Give your project a name, or keep default for a first try.\n')
        default = self.plan.get('project') or 'default'
        while True:
            name = self.ask(f'Project name [{default}]:', default=default,
                            help_text='A workspace shares provider connections across its projects and runs one GeoCluster session at a time. Use another workspace for separate connections or simultaneous sessions.')
            try:
                self.support.validate_project(name)
            except (self.support.SetupError, ValueError):
                self.say('Choose a name with 1–64 letters, numbers, hyphens, or underscores.\nStart with a letter or number. Use another name instead of datasets.')
                continue
            if name != self.plan.get('project'):
                self.plan['operation'] = None
                self.copy_ready = self.resume_operation = False
            self.plan['project'] = name
            self.say(f'Project: {name}')
            self.inspect()
            if self.inspection.get('exists'):
                self.say(f"Welcome back to {name}. We'll continue with the files already here.")
            else:
                self.say(f"We'll create {name} at /workspace/{name}.")
            return

    def child_names(self):
        return {item if isinstance(item, str) else item.get('name', item.get('path', '')) for item in self.inspection.get('children', [])}

    def fresh_name(self, destination, reserved=()):
        names = self.child_names() | set(reserved)
        index = 2
        while True:
            candidate = destination[: max(1, 64 - len(str(index)) - 1)] + f'-{index}'
            if candidate not in names:
                return candidate
            index += 1

    def destination(self, default, uncertain=False, reserved=()):
        proposed = default
        while True:
            self.support.validate_destination(proposed)
            if proposed not in self.child_names() and proposed not in reserved:
                return proposed
            fresh = self.fresh_name(proposed, reserved)
            if uncertain:
                self.say(f"We couldn't confirm that the copy to {proposed} finished.\nWe can copy your data into {fresh} instead.\n")
            elif proposed in self.child_names():
                self.say(f"There's already a folder named {proposed}.\nWe can put this copy in {fresh}.\n")
            else:
                self.say(f"There was a previous sample copy named {proposed}.\nWe can put a fresh copy in {fresh}.\n")
            if self.confirm(f'Use {fresh}', help_text='Copies never merge into or replace an existing folder. Choose No for another name or to continue without adding files.'):
                return fresh
            if self.menu(['Choose another folder name', 'Continue with existing files and add nothing'], help_text='Existing folders stay unchanged.') == 2:
                return None
            while True:
                proposed = self.ask('Folder name inside the project:', expected='a folder name', help_text='Choose a new, ordinary child folder name. Existing folders are never replaced.')
                try:
                    self.support.validate_destination(proposed)
                    break
                except (self.support.SetupError, ValueError) as exc:
                    self.say(str(exc))

    def personal(self, destination=None):
        project = self.plan['project']
        self.say(f"Choose the folder to copy into {project}.\nYour original folder stays where it is.\n")
        while True:
            value = self.ask('Source folder on this computer:', expected='a source folder',
                             help_text='Copy complete related data folders. Shapefiles need .shx, .dbf, and .prj files; drillhole assays usually need collars and surveys. Links, special files, and protected runtime state cannot be copied.')
            source = Path(value).expanduser().absolute()
            try:
                manifest, restricted = self.support.prepare_import(source)
                self.manifest = manifest
            except (OSError, ValueError) as exc:
                self.say(f"We couldn't copy {source}: {exc}.\nChoose another source folder, or type b to return to starting files.")
                continue
            # Config and plugin detection is advisory, never a deny-list.
            entries = manifest.get('entries', []) if isinstance(manifest, dict) else manifest
            paths = [entry.get('path', '') if isinstance(entry, dict) else str(entry) for entry in entries]
            if any(any(part in ('.opencode', '.claude', 'opencode.json', 'opencode.jsonc', 'plugins', 'plugin') for part in Path(path).parts) for path in paths):
                self.say('This folder includes configuration or plugins that GeoCluster can run. Use a source you trust.')
            self.allow_restricted = False
            if restricted:
                self.say('These files are private to your account:')
                for path in restricted:
                    self.say(f'  {path}')
                self.say("\nWe'll give GeoCluster's tools access to the project copy.\n")
                try:
                    include = self.confirm('Include these files', help_text='Only the project copy becomes accessible to GeoCluster service accounts. Original content and permissions stay unchanged.')
                except Back:
                    continue
                if not include:
                    if self.menu(['Choose another source folder', 'Return to starting files'], help_text='You can also start with sample files or add data later.') == 2:
                        raise Back()
                    continue
                self.allow_restricted = True
            if not self.docker.local_host:
                self.say(f"We'll copy this folder to {self.docker.label}.")
            if destination is None:
                default = source.name
                while True:
                    try:
                        destination = self.ask(f'Folder name inside the project [{default}]:', default=default,
                                               help_text='Use one new child folder name; imports never merge into existing content.')
                    except Back:
                        destination = None
                        break
                    try:
                        self.support.validate_destination(destination)
                        break
                    except (self.support.SetupError, ValueError) as exc:
                        self.say(str(exc))
                if destination is None:
                    continue
            try:
                destination = self.destination(destination)
            except Back:
                destination = None
                continue
            self.source = source
            self.say(f'Source: {source}')
            self.plan['starter'] = {'kind': 'personal', 'destination': destination} if destination else {'kind': 'existing', 'destination': None}
            return

    def verified_sample(self):
        for item in self.inspection.get('samples', []):
            if self.unchanged(item):
                self.plan['operation'] = item.get('operation')
                return item['destination']
        return None

    def unchanged(self, receipt):
        return receipt.get('state') == 'verified' and (receipt.get('outcome') == 'unchanged' or receipt.get('unchanged') is True)

    def choose_starter(self):
        self.sample_verified = False
        self.copy_ready = self.resume_operation = False
        self.plan['operation'] = None
        self.source = None
        while True:
            existing = self.inspection.get('exists', False)
            self.heading(5, 'Choose starting files' + (f" for {self.plan['project']}" if existing else ''))
            if existing:
                items = ['Continue with the files already here (default)', 'Add Wattle Creek samples', 'Copy another data folder']
            else:
                items = ['Wattle Creek sample files (recommended for a first try)\n   Explore synthetic surface and drillhole data with a suggested first question.',
                         'Copy your own data folder\n   Bring a copy of your data into the project.', 'Add files later']
            choice = self.menu(items, help_text='Wattle Creek includes surface assays, drillhole collars, and drillhole assays. Personal imports copy a complete folder. Add files later never clears a project.')
            kind = ({1: 'existing', 2: 'samples', 3: 'personal'} if existing else {1: 'samples', 2: 'personal', 3: 'none'})[choice]
            try:
                if kind == 'personal':
                    self.personal()
                elif kind == 'samples':
                    destination = self.verified_sample()
                    if destination:
                        self.copy_ready = self.sample_verified = True
                        self.say(f'Wattle Creek samples are ready in {destination}.')
                    else:
                        recorded = {item['destination'] for item in self.inspection.get('samples', [])}
                        destination = self.destination('wattle-creek', reserved=recorded)
                    self.plan['starter'] = {'kind': 'samples', 'destination': destination} if destination else {'kind': 'existing', 'destination': None}
                    if destination:
                        self.say(f"You'll find the samples in:\n  /workspace/{self.plan['project']}/{destination}")
                else:
                    self.plan['starter'] = {'kind': kind, 'destination': None}
                    self.say("We'll prepare the project so you can add your data when you're ready." if kind == 'none' else 'Continuing with your existing files.')
                return
            except Back:
                continue

    def recover(self):
        """Receipts establish completion; the pending file never establishes it."""
        self.inspect()
        starter = self.plan['starter'] or {'kind': 'existing', 'destination': None}
        self.plan['starter'] = starter
        if starter['kind'] in ('existing', 'none'):
            return
        operation = self.plan.get('operation')
        if not operation:
            kind = 'samples' if starter['kind'] == 'samples' else 'import'
            candidates = {item['operation'] for item in self.inspection.get('operations', [])
                          if item.get('project') == self.plan['project'] and item.get('destination') == starter.get('destination') and item.get('kind') == kind}
            if len(candidates) == 1:
                operation = candidates.pop()
                self.plan['operation'] = operation
        receipt = None
        if operation:
            while True:
                try:
                    self.check()
                    receipt = self.docker.operation(self.plan['storage'], self.plan['image']['id'], ['receipt', '--operation', operation])
                    break
                except self.support.SetupError as exc:
                    if getattr(exc, 'code', '').replace('-', '_') in ('not_found', 'missing_receipt', 'receipt_missing'):
                        break
                    if self.is_busy(exc):
                        if self.busy(exc):
                            continue
                    raise
        if isinstance(receipt, dict):
            receipt = receipt.get('receipt', receipt)
        if receipt and (receipt.get('project') != self.plan['project'] or receipt.get('destination') != starter.get('destination')):
            raise self.error('The saved operation does not match the selected project and folder. Keep existing copies and choose starting files again.', 'invalid_receipt')
        if receipt and self.unchanged(receipt):
            self.copy_ready = True
            self.sample_verified = starter['kind'] == 'samples'
            self.say(f"Your previous copy is ready in {starter['destination']}.")
            return
        if receipt and receipt.get('state') == 'staged' and starter.get('destination') not in self.child_names():
            self.resume_operation = True
            return
        if receipt and receipt.get('state') in ('verified', 'published') and starter.get('destination') not in self.child_names():
            self.say(f"The previous copy at {starter['destination']} is no longer here. We'll continue without restoring it.")
            self.plan['starter'] = {'kind': 'existing', 'destination': None}
            self.plan['operation'] = None
            return
        if receipt and receipt.get('state') == 'verified':
            self.say(f"The files in {starter['destination']} have changed. We'll continue with your existing files.")
            self.plan['starter'] = {'kind': 'existing', 'destination': None}
            self.plan['operation'] = None
            return
        self.plan['operation'] = None
        if starter['kind'] in ('samples', 'personal'):
            destination = self.destination(starter.get('destination') or 'wattle-creek', uncertain=True)
            if destination is None:
                self.plan['starter'] = {'kind': 'existing', 'destination': None}
            elif starter['kind'] == 'personal':
                self.personal(destination)
            else:
                self.plan['starter']['destination'] = destination

    def change_settings(self, back_to=6):
        self.say('\nWhat would you like to change?\n')
        try:
            choice = self.menu(['Where files are kept', 'Project name', 'Starting files', 'Finish later'], help_text='Changing choices does not undo completed work. A new preparation summary needs your approval before it is applied.')
        except Back:
            return back_to
        if choice == 4:
            raise Cancel()
        return choice + 2

    def review_help(self):
        self.say(f"Image ID: {self.plan['image']['id']}\nLaunch settings: {self.repo / '.geocluster/setup.json'}\n" + self.explicit_command())
        if self.host_plan:
            for key in ('source', 'source_path', 'digest', 'sha256', 'command', 'description'):
                if key in self.host_plan:
                    value = self.host_plan[key]
                    self.say(f'{key}: ' + (shlex.join(value) if isinstance(value, (list, tuple)) else str(value)))
            self.say('Only the approved dedicated workspace root is created as root. Existing ownership and permissions are never repaired.')

    def summary(self):
        self.heading(6, 'Review and apply')
        self.say("Let's set up your project with these choices:\n")
        storage = self.plan['storage']
        self.check()
        if storage['kind'] == 'volume':
            exists = self.docker.volume_exists(storage['name'])
            description = f"Continue in {storage['name']}" if exists else f"Docker-managed storage, {storage['name']}"
        else:
            exists = Path(storage['path']).exists()
            description = ('Use ' if exists else 'Create ') + storage['path']
        starter = self.plan['starter']
        kind, destination = starter['kind'], starter['destination']
        starting = {'samples': f"Wattle Creek samples in {self.plan['project']}/{destination}",
                    'personal': f"Copy {self.source} to {self.plan['project']}/{destination}" if self.source else f'Continue with your data in {destination}',
                    'none': 'Add files later', 'existing': 'Continue with your existing files'}[kind]
        project = ('Continue ' if self.inspection.get('exists') else '') + self.plan['project']
        self.say(f"GeoCluster:     {self.plan['image']['reference']}\nWorkspace:      {description}\nProject:        {project}\nStarting files: {starting}\nNext time:      ./scripts/tui.sh\n")
        if kind == 'samples':
            self.say("We'll prepare the workspace, add the samples, and save your choices." if not self.copy_ready else "We'll save these choices and continue with your samples.")
        elif kind == 'personal':
            self.say(f"We'll prepare {self.plan['project']} and copy your data into {destination}." if not self.copy_ready else f"We'll save these choices and open {self.plan['project']}.")
        elif kind == 'none':
            self.say(f"We'll prepare {self.plan['project']} for you to add files later.")
        else:
            self.say(f"We'll save these choices and open {self.plan['project']}.")
        if storage['kind'] == 'bind':
            # Capture held parent identities and source bytes before approval.
            if self.host_plan is None:
                self.host_plan = self.support.host_root_plan(Path(storage['path']))
            if not self.host_plan.get('existing', exists):
                self.say(f"\nWe'll use administrator access to create {storage['path']}.\nYour system may ask for your password during this step.")
        if self.saved:
            self.say(f"Next time, ./scripts/tui.sh will open {self.plan['project']}.")
        self.say()
        return self.confirm('Prepare this project', help_text='The image is already prepared. This approval prepares storage and files, then saves the selected launch settings.', help_action=self.review_help)

    def is_busy(self, exc):
        return getattr(exc, 'code', '').replace('-', '_') in ('busy', 'locked', 'workspace_in_use', 'workspace_busy')

    def busy(self, exc):
        self.say(f"{self.storage_description()} is open in another GeoCluster session or file operation.\nClose that session or let the copy finish, then continue here.\n")
        return self.confirm('Try again', help_text='GeoCluster and transfers share one exclusive workspace lock. Close the other session, or go back to choose another workspace.')

    def retry(self, action):
        self.say('Completed: ' + (', '.join(self.completed) or 'no completed tasks confirmed') + '.')
        self.say(f'Still to do: {action}.\n')
        return self.confirm('Try again', help_text='Retry only after resolving the cause shown above. Completed work is kept. Type b to change choices or q to finish later.')

    def handle_changed_project(self, exc):
        code = getattr(exc, 'code', '').replace('-', '_')
        if code in ('project_exists', 'project_appeared'):
            if self.confirm(f"{self.plan['project']} is already here. Continue with its files", help_text='The project appeared after review. Continuing adds no starting files.'):
                self.inspection['exists'] = True
                self.plan['starter'] = {'kind': 'existing', 'destination': None}
                self.plan['operation'] = None
                self.copy_ready = self.resume_operation = False
                return True
        if code in ('project_missing', 'project_disappeared'):
            if self.confirm(f"Create {self.plan['project']} again", help_text='The selected existing project disappeared after review. This creates a new project; it does not restore deleted files.'):
                self.inspection['exists'] = False
                self.plan['starter'] = {'kind': 'existing', 'destination': None}
                self.plan['operation'] = None
                self.copy_ready = self.resume_operation = False
                return True
        return False

    def apply(self):
        # Each new approval revalidates under the lock, including a save retry.
        self.prepared = False
        self.start('preparing your project', 6)
        storage = self.plan['storage']
        self.check()
        self.say(f'Preparing workspace {self.storage_description()}...')
        if storage['kind'] == 'volume':
            if not self.docker.volume_exists(storage['name']):
                self.docker.ensure_volume(storage['name'])
                self.mark(f"workspace {storage['name']} created")
        else:
            try:
                self.check()
                self.support.create_host_root(self.host_plan)
                if not self.host_plan.get('existing'):
                    self.mark(f"workspace {storage['path']} created")
            except (self.support.SetupError, OSError) as exc:
                if getattr(exc, 'code', '').replace('-', '_') in ('identity', 'docker_changed'):
                    raise
                self.say("We couldn't get administrator access to create this folder.\nDocker-managed storage is another way to get started.\n")
                if self.confirm('Use Docker-managed storage instead', help_text=str(exc) + '\n' + self.custom_guide()):
                    self.plan['storage'] = {'kind': 'volume', 'name': VOLUME}
                    self.host_plan = None
                    self.plan['operation'] = None
                    self.copy_ready = self.resume_operation = self.prepared = False
                    self.inspect()
                    self.active = None
                    return 6
                choice = self.menu(['Try creating the folder again', 'Choose where files are kept'], help_text=self.custom_guide())
                self.active = None
                return 6 if choice == 1 else 3
        while not self.prepared:
            try:
                self.check()
                starter = self.plan['starter']
                kind, destination = starter['kind'], starter['destination']
                expect = 'existing' if self.inspection.get('exists') else 'absent'
                args = ['prepare', '--project', self.plan['project'], '--expect', expect]
                if self.resume_operation or self.copy_ready and self.plan.get('operation'):
                    result = self.docker.operation(storage, self.plan['image']['id'], [*args, '--resume', self.plan['operation']])
                elif kind == 'personal' and not self.copy_ready:
                    self.say(f'Adding your data in {destination}...')
                    result = self.support.import_source(self.docker, storage, self.plan['image']['id'], self.plan['project'], destination, self.source, self.allow_restricted, expect=expect, manifest=self.manifest)
                elif kind == 'samples' and not self.copy_ready:
                    self.say(f'Adding Wattle Creek samples in {destination}...')
                    result = self.docker.operation(storage, self.plan['image']['id'], [*args, '--samples', '--destination', destination])
                else:
                    result = self.docker.operation(storage, self.plan['image']['id'], args)
                if result.get('operation'):
                    self.plan['operation'] = result['operation']
                    self.pending(6)
                self.say('Checking the project...')
                self.inspect()
                if not self.inspection.get('exists'):
                    raise self.error(f"We couldn't verify {self.plan['project']} after preparation.")
                if not self.unchanged(result):
                    raise self.error('The workspace helper did not confirm verified preparation. Keep existing files and review setup again.', 'unverified_copy')
                if kind in ('samples', 'personal'):
                    self.copy_ready = True
                    self.sample_verified = kind == 'samples'
                    self.mark(f'{kind} ready in {destination}')
                self.prepared = True
                self.mark(f"project {self.plan['project']} prepared")
                self.pending(6)
            except (self.support.SetupError, ValueError) as exc:
                if self.is_busy(exc):
                    if self.busy(exc):
                        continue
                    self.active = None
                    return 3 if self.menu(['Choose another workspace', 'Finish with this issue unresolved'], help_text='No project files are replaced.') == 1 else 0
                if self.handle_changed_project(exc):
                    self.pending(6)
                    continue
                if getattr(exc, 'code', '').replace('-', '_') in ('destination_exists', 'collision', 'unverified_copy'):
                    self.inspect()
                    if self.plan.get('operation'):
                        self.recover()
                        self.active = None
                        return 6
                    if not self.plan['starter'].get('destination'):
                        raise
                    destination = self.destination(self.plan['starter']['destination'], uncertain=True)
                    self.plan['starter'] = dict(self.plan['starter'], destination=destination) if destination else {'kind': 'existing', 'destination': None}
                    self.active = None
                    return 6
                self.say(f"We couldn't finish preparing your project: {exc}\nRun ./scripts/setup.sh to review the selected workspace and finish preparation.")
                if getattr(exc, 'code', '').replace('-', '_') in ('identity', 'docker_changed', 'unsafe', 'unsafe_path', 'unsafe_workspace', 'unsafe_project', 'platform', 'source_changed', 'permission_required'):
                    raise
                self.active = None
                if self.retry('preparing your project'):
                    # Do not repeat an uncertain import blindly. Reconcile first.
                    self.recover()
                    if self.copy_ready:
                        self.prepared = True
                    continue
                return 0
        self.active = 'saving your settings'
        self.say('Saving your settings...')
        while True:
            try:
                self.check()
                self.support.save_profile(self.plan, self.guide())
                self.mark('launch settings saved')
                self.active = None
                return 7
            except (self.support.SetupError, OSError) as exc:
                self.say(f'Your project files are ready. We still need to save the launch settings.\n{exc}')
                # Re-review before retrying a profile write; never duplicate data.
                if self.retry('saving the launch settings'):
                    self.active = None
                    return 6
                return 0

    def explicit_command(self):
        args = ['./scripts/run-runtime-tui.sh', '--image', self.plan['image']['id']]
        storage = self.plan['storage']
        args += ['--workspace-volume', storage['name']] if storage['kind'] == 'volume' else ['--workspace-root', storage['path']]
        args += ['--project', self.plan['project'], '--require-existing-project']
        return shlex.join(args)

    def first_use(self):
        text = 'Once GeoCluster opens:\n\n1. Run /connect to connect your model provider.\n2. Run /models to choose a model.\n\nYour chosen provider handles model requests and any project content included\nwith them. Model usage follows that provider\'s pricing.\n'
        kind = self.plan['starter']['kind']
        destination = self.plan['starter']['destination']
        if kind == 'samples' and self.sample_verified:
            text += f'\nTry this first question with the samples:\n\n  Compare {destination}/drilling/assays.csv with\n  {destination}/drilling/collars.csv using hole_id. Save assay rows with\n  no matching drillhole and a short data-quality report. Keep the input\n  files unchanged.\n'
        elif kind == 'personal':
            text += f'\nTry this first question with your data:\n\n  List the files in {destination}/. Explain what data is present and\n  what related files may be missing. Do not change the input files.\n'
        elif kind == 'none':
            text += "\nWhen you're ready to add data, run /exit inside GeoCluster.\nThen run this in your usual terminal:\n  ./scripts/project-files.sh import\n\nWe'll help you choose a folder to bring into the project.\n"
        else:
            text += f"\nPick up where you left off, or ask GeoCluster about a folder in {self.plan['project']}.\n"
        return text

    def outcome(self):
        destination = self.plan['starter']['destination']
        return {'samples': f'Samples: {destination}/', 'personal': f'Your data: {destination}/',
                'none': 'Ready for you to add files.', 'existing': 'Continuing with your existing files.'}[self.plan['starter']['kind']]

    def guide(self):
        text = f"GeoCluster project: {self.plan['project']}\nWorkspace: {self.storage_description()}\n{self.outcome()}\n\n{self.first_use()}"
        if self.sample_verified:
            text += '\nFor the sample check, look for WC141: it has assay intervals but no collar.\n'
        text += f'\nReturn to this project\n\nFrom {self.repo}:\n  ./scripts/tui.sh\n\nEquivalent explicit launch command:\n  {self.explicit_command()}\n\nChange saved choices:\n  ./scripts/setup.sh\n\nFinish pending work, then run /exit to close GeoCluster.\nKeep this workspace to continue with your files, conversations, and connections.\n\nResults: runs/<session-id>/results/ in the project.\nAnswers list created files. Review them before sharing.\n\nBefore either transfer, run /exit inside GeoCluster.\n\nExport: stop other project editors, then run in your normal terminal:\n  ./scripts/project-files.sh export\nChoose a project folder and output location when prompted.\n\nImport, from your normal terminal:\n  ./scripts/project-files.sh import\nChoose source and destination folders when prompted. Originals stay unchanged.\n\nDocument extraction\n\nGeoCluster can read text already present in PDF files.\nTo extract text from scanned pages, follow the document-processing guide:\n  {self.public_guide("NATIVE_DOCUMENT_PROCESSING.md")}\n\nProvider login\n\nNo callback ports are published. Use a supported API-key or device-code\nconnection method; browser logins that require a callback may need custom setup.\n'
        return text

    def finish(self):
        self.heading(7, 'Your project is ready')
        self.say(f"Project: {self.plan['project']}\nWorkspace: {self.storage_description()}\n{self.outcome()}\n\n{self.first_use()}")
        self.say(f"To open this project again, run:\n  ./scripts/tui.sh\n\nYour first-use guide, including file-transfer commands, is saved at:\n  {self.repo / '.geocluster/next-steps.txt'}\n\nEquivalent explicit launch command:\n  {self.explicit_command()}\n")
        if not self.confirm('Start GeoCluster now', help_text='Provider login happens inside GeoCluster; setup never collects keys. No callback ports are published. Supported API-key or device-code methods work without publishing ports. Type b to change saved choices.'):
            self.say('Your project is ready. Open it whenever you like with ./scripts/tui.sh.')
            return 0
        try:
            self.check()
            result = self.support.launch(self.plan)
            if result not in (None, 0):
                raise self.error(f'The terminal interface exited with status {result}.')
            return 0
        except (self.support.SetupError, OSError, subprocess.CalledProcessError) as exc:
            self.say(f"Your project is ready. Let's resolve the launch issue:\n{exc}\nResolve the cause above, then open it with:\n  ./scripts/tui.sh")
            return 1

    def run(self):
        try:
            self.opening()
            self.computer()
            resumed_stage = self.stage
            self.prepare_image()
            step = max(3, resumed_stage) if self.resume else 3
            if not self.plan.get('storage'):
                step = 3
            elif not self.plan.get('project'):
                step = min(step, 4)
            if self.resume and step >= 5:
                try:
                    self.recover()
                    if step == 5 and (self.copy_ready or self.resume_operation):
                        step = 6
                except Back:
                    step = 5
            while True:
                try:
                    if step == 2:
                        self.resume = False
                        self.prepare_image()
                        step = 3
                    elif step == 3:
                        before = copy.deepcopy(self.plan['storage'])
                        self.choose_storage()
                        if before != self.plan['storage']:
                            self.plan['operation'] = None
                            self.copy_ready = self.resume_operation = self.prepared = False
                        self.review_route = self.reviewing
                        step = 4
                    elif step == 4:
                        before = self.plan['project']
                        self.choose_project()
                        if before != self.plan['project']:
                            self.prepared = False
                        # A new storage/project selection needs an appropriate
                        # existing/new starter choice, not a stale import plan.
                        step = 6 if self.reviewing and not self.review_route and before == self.plan['project'] else 5
                        self.review_route = False
                    elif step == 5:
                        self.inspect()
                        self.choose_starter()
                        self.prepared = False
                        step = 6
                    elif step == 6:
                        try:
                            approved = self.summary()
                        except Back:
                            step = 5
                            continue
                        if approved:
                            step = self.apply()
                            if step == 0:
                                self.say('Completed: ' + (', '.join(self.completed) or 'no completed tasks confirmed') + '.')
                                return 1
                        else:
                            self.reviewing = True
                            step = self.change_settings()
                    else:
                        return self.finish()
                except Back:
                    if step in (6, 7):
                        self.reviewing = True
                        step = self.change_settings(back_to=step)
                    else:
                        step = max(2, step - 1)
        except (Cancel, KeyboardInterrupt):
            return self.cancel()
        except Back:
            # There is no earlier manual choice before automatic checks.
            return self.cancel()
        except (self.support.SetupError, OSError, subprocess.CalledProcessError, ValueError) as exc:
            self.say(str(exc))
            if self.started:
                self.say('Completed: ' + (', '.join(self.completed) or 'no completed tasks confirmed') + '.')
            self.say('Run ./scripts/setup.sh to continue after resolving this issue.')
            return 1


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ['--help']:
        print('Usage: ./scripts/setup.sh\n\nSet up a native GeoCluster project in seven guided steps.\nPress Enter for defaults, ? for help, b to go back, or q to quit.\nAn interactive terminal is required. Setup never collects provider credentials.\n\nFor unattended use, run scripts/build-docker.sh and scripts/run-runtime-tui.sh.\nTo return to your saved project, run ./scripts/tui.sh.')
        return 0
    if argv:
        print('Usage: ./scripts/setup.sh [--help]', file=sys.stderr)
        return 2
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print('Setup needs an interactive terminal. Run ./scripts/setup.sh in your terminal.\nFor unattended setup, use scripts/build-docker.sh and scripts/run-runtime-tui.sh.', file=sys.stderr)
        return 2
    import setup_common
    return Wizard(setup_common).run()


if __name__ == '__main__':
    sys.exit(main())
