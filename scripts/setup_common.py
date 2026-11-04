"""Small host adapter for saved native launches and locked workspace operations."""
import csv
import io
import json
import os
from pathlib import Path
import re
import shlex
import stat
import struct
import subprocess
import sys
import tempfile
import uuid

REPO = Path(__file__).resolve().parent.parent
STATE = REPO / '.geocluster'
sys.path.insert(0, str(REPO / 'runtime'))
from setup_transfer import (validate_project as _validate_project, validate_destination as _validate_destination,
                            capture_source, validate_archive_headers, build_archive, canonical_hash)

LIMIT = 65536
NATIVE_PROJECT = 'default'
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')
FINGERPRINT = re.compile(r'^[0-9a-f]{64}$')
VOLUME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')


class SetupError(ValueError):
    def __init__(self, message, code='failed', details=None):
        super().__init__(message)
        self.code, self.details = code, details or {}


def _transfer_message(message, code, details):
    if code not in ('unsafe_path', 'unsupported_path') or not isinstance(details.get('path'), str):
        return message
    if not isinstance(details.get('source'), str) and details.get('path_scope') != 'transfer_source':
        return message
    lines = []
    source = details.get('source')
    if isinstance(source, str):
        lines.append('Source folder: ' + repr(source))
        label = 'Offending path: '
    else:
        label = 'Offending path (relative to transfer source): '
    lines.append(label + repr(details['path']))
    lines.append('Reason: ' + message)
    if isinstance(details.get('hint'), str) and details['hint']:
        lines.append('Next step: ' + details['hint'])
    return '\n'.join(lines)


def _source_error(error, source, fallback_code):
    code = getattr(error, 'code', fallback_code)
    details = {**getattr(error, 'details', {}), 'source': os.path.abspath(os.fsdecode(source))}
    return SetupError(_transfer_message(str(error), code, details), code, details)


def validate_project(value):
    try:
        return _validate_project(value)
    except ValueError as error:
        raise SetupError(str(error), 'usage') from error


def validate_destination(value):
    try:
        return _validate_destination(value)
    except ValueError as error:
        raise SetupError(str(error), 'usage') from error


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SetupError('Settings contain a duplicate JSON field.')
        result[key] = value
    return result


def parse_json(raw):
    if len(raw) > LIMIT:
        raise SetupError('Settings or Docker metadata exceed the supported size.')
    try:
        return json.loads(raw, object_pairs_hook=_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non-finite JSON')))
    except (ValueError, UnicodeError) as error:
        raise SetupError('Could not read valid JSON settings or Docker metadata.') from error


def _fields(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise SetupError('Settings have missing or unsupported fields. Run ./scripts/setup.sh again.')


def _text(value, maximum=4096):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise SetupError('Settings contain an invalid text value.')
    return value


def validate_storage(storage):
    if not isinstance(storage, dict):
        raise SetupError('Choose a workspace volume or a prepared host folder.')
    if storage.get('kind') == 'volume':
        _fields(storage, ('kind', 'name'))
        if not isinstance(storage['name'], str) or not VOLUME.fullmatch(storage['name']):
            raise SetupError('Workspace names must start with a letter or number and use letters, numbers, dots, underscores, or hyphens.')
    elif storage.get('kind') == 'bind':
        _fields(storage, ('kind', 'path'))
        path = _text(storage['path'])
        if not Path(path).is_absolute() or str(Path(path)) != path or '..' in Path(path).parts:
            raise SetupError('The workspace folder must be an absolute, normalized path.')
    else:
        raise SetupError('Unknown workspace storage choice.')
    return storage


def _incompatible_settings(reason, code):
    sibling = STATE.with_name(STATE.name + '-saved-' + uuid.uuid4().hex[:8])
    return SetupError(reason + '\nNative setup now uses one workspace.\n'
                      'Move the local .geocluster settings directory aside without overwriting another backup:\n  '
                      + shlex.join(['mv', '-T', '-n', '--', str(STATE), str(sibling)])
                      + '\nRetain the moved settings and all workspace files. Then run ./scripts/setup.sh again.\n'
                      'New setup uses default/ inside the selected storage; it does not discover or migrate named folders.', code)


def validate_profile(value, pending=False):
    if isinstance(value, dict) and 'version' in value and (type(value['version']) is not int or value['version'] != 2):
        raise _incompatible_settings('These saved settings use an unsupported setup version.', 'settings_version')
    required = ('version', 'image', 'docker', 'storage', 'project', 'operation', 'starter')
    _fields(value, ('version',) if pending else required,
            tuple(set(required) - {'version'}) + ('stage', 'allowRestricted', 'completed') if pending else ())
    image = value.get('image')
    if image is not None:
        _fields(image, ('reference', 'id', 'created'))
        _text(image['reference'], 1024)
        _text(image['created'], 128)
        if not isinstance(image['id'], str) or not IMAGE_ID.fullmatch(image['id']):
            raise SetupError('The saved image requires an immutable Docker image ID.')
    elif not pending:
        raise SetupError('No image was selected in the saved settings.')
    docker = value.get('docker')
    if docker is not None:
        _fields(docker, ('fingerprint', 'label'))
        if not isinstance(docker['fingerprint'], str) or not FINGERPRINT.fullmatch(docker['fingerprint']):
            raise SetupError('Invalid saved Docker destination.')
        if docker['label'] not in ('local Linux Docker', 'remote Docker connection', 'custom Docker connection'):
            raise SetupError('Invalid saved Docker description.')
    elif not pending:
        raise SetupError('No Docker destination was saved.')
    if value.get('storage') is not None:
        validate_storage(value['storage'])
    elif not pending:
        raise SetupError('No workspace was saved.')
    if value.get('project') is not None:
        if value['project'] != NATIVE_PROJECT:
            raise _incompatible_settings('These saved settings select a named project instead of the fixed internal directory default/.', 'settings_project')
    elif not pending:
        raise SetupError('The saved workspace requires the fixed internal directory default/.')
    if value.get('operation') is not None:
        try:
            if str(uuid.UUID(value['operation'])) != value['operation']:
                raise ValueError()
        except (ValueError, TypeError, AttributeError) as error:
            raise SetupError('Invalid completed-operation reference.') from error
    starter = value.get('starter')
    if starter is not None:
        _fields(starter, ('kind', 'destination'))
        if starter['kind'] not in ('samples', 'personal', 'none', 'existing'):
            raise SetupError('Invalid starting-file choice.')
        if starter['destination'] is not None:
            validate_destination(starter['destination'])
        elif starter['kind'] in ('samples', 'personal') and not pending:
            raise SetupError('Starting files require a destination folder.')
    elif not pending:
        raise SetupError('No starting-file choice was saved.')
    if 'stage' in value and (type(value['stage']) is not int or not 1 <= value['stage'] <= 6):
        raise SetupError('Invalid pending setup stage.')
    if 'allowRestricted' in value and type(value['allowRestricted']) is not bool:
        raise SetupError('Invalid copy-access decision.')
    if 'completed' in value:
        if not isinstance(value['completed'], list) or len(value['completed']) > 32:
            raise SetupError('Invalid completed-action summary.')
        for action in value['completed']:
            _text(action, 2048)
    return value


def _state_fd(create=False):
    if create:
        try:
            STATE.mkdir(mode=0o700)
        except FileExistsError:
            pass
    try:
        fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise _unsafe_state(STATE, 'The setup entry must be a real directory, not a link or another object.') from error
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise _unsafe_state(STATE, 'Expected a folder owned by your account with mode 0700.')
    return fd


def _load(name, pending=False):
    try:
        parent = _state_fd()
    except FileNotFoundError:
        return None
    try:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise _unsafe_state(STATE / name, 'Expected an ordinary file owned by your account with mode 0600.')
            value = parse_json(stream.read(LIMIT + 1))
        return validate_profile(value, pending)
    finally:
        os.close(parent)


def load_profile():
    return _load('setup.json')


def load_pending():
    return _load('pending.json', True)


def _unsafe_state(path, reason):
    sibling = STATE.with_name(STATE.name + '-saved-' + uuid.uuid4().hex[:8])
    return SetupError(f'We need to sort out the setup folder at {path}.\n{reason}\n\nCheck it with:\n  '
                      + shlex.join(['ls', '-ld', '--', str(path)])
                      + '\nMove it aside to let setup create fresh settings:\n  '
                      + shlex.join(['mv', '-T', '-n', '--', str(STATE), str(sibling)])
                      + '\nIf you need access, ask its owner or your administrator to help.\nThen run ./scripts/setup.sh again.', 'unsafe_state')


def _safe_record(parent, name):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise _unsafe_state(STATE / name, 'Expected an ordinary file owned by your account with mode 0600.')


def _write(parent, name, raw):
    _safe_record(parent, name)
    temporary = '.' + name + '.' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def save_pending(value):
    validate_profile(value, True)
    raw = (json.dumps(value, sort_keys=True) + '\n').encode()
    if len(raw) > LIMIT:
        raise SetupError('Pending setup settings exceed the supported size.')
    parent = _state_fd(True)
    try:
        _write(parent, 'pending.json', raw)
        _safe_record(parent, 'apply.log')
        log = os.open('apply.log', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            event = {'event': 'approved_plan_saved', 'stage': value.get('stage'),
                     'project': value.get('project'), 'operation': value.get('operation')}
            os.write(log, (json.dumps(event, sort_keys=True) + '\n').encode())
            os.fsync(log)
        finally:
            os.close(log)
    finally:
        os.close(parent)


def save_profile(value, guide):
    validate_profile(value)
    if not isinstance(guide, str) or len(guide.encode()) > LIMIT:
        raise SetupError('The first-use guide exceeds the supported size.')
    parent = _state_fd(True)
    previous = None
    try:
        try:
            _safe_record(parent, 'next-steps.txt')
            old = os.open('next-steps.txt', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            with os.fdopen(old, 'rb') as stream:
                previous = stream.read(LIMIT + 1)
        except FileNotFoundError:
            pass
        _write(parent, 'next-steps.txt', guide.encode())
        try:
            _write(parent, 'setup.json', (json.dumps(value, sort_keys=True) + '\n').encode())
        except OSError:
            if previous is not None:
                _write(parent, 'next-steps.txt', previous)
            else:
                os.unlink('next-steps.txt', dir_fd=parent)
                os.fsync(parent)
            raise
        # A leftover pending record is harmless; saving the profile is the commit point.
        try:
            os.unlink('pending.json', dir_fd=parent)
            os.fsync(parent)
        except FileNotFoundError:
            pass
    finally:
        os.close(parent)


class Docker:
    def __init__(self):
        identity, label, local = self._identity()
        self.fingerprint = canonical_hash(identity)
        self.label, self.local_host = label, local

    def _run(self, args, *, input_file=None, output_file=None):
        try:
            result = subprocess.run(['docker', *args], stdin=input_file,
                                    stdout=output_file if output_file is not None else subprocess.PIPE,
                                    stderr=subprocess.PIPE,
                                    timeout=30 if args[0] in ('info', 'context', 'image', 'volume') or '--capabilities' in args else None)
        except FileNotFoundError as error:
            raise SetupError('Install Docker to continue: https://docs.docker.com/engine/install/', 'docker_unavailable') from error
        except subprocess.TimeoutExpired as error:
            raise SetupError('The Docker connection did not respond in time. Select a working connection, then try again.', 'docker_unavailable') from error
        if result.returncode:
            if args[:2] == ['volume', 'inspect'] and b'no such volume' in result.stderr.lower():
                raise SetupError('The selected workspace volume does not exist.', 'volume_missing')
            # Docker diagnostics can contain endpoint credentials. Surface only structured helper errors.
            details = {}
            try:
                line = result.stderr.splitlines()[-1]
                parsed = parse_json(line)
                if isinstance(parsed, dict) and isinstance(parsed.get('error'), str) and isinstance(parsed.get('message'), str):
                    details = parsed
            except (IndexError, ValueError):
                pass
            if details:
                raise SetupError(_transfer_message(details['message'], details['error'], details),
                                 details['error'], details)
            if b'workspace volume is already owned by another runtime' in result.stderr:
                raise SetupError('This workspace is open in another GeoCluster session or file operation. Close that session or let the copy finish, then retry.', 'workspace_busy')
            raise SetupError('Docker could not finish this action. Start Docker, or select a working Docker connection.', 'docker_failed')
        return result.stdout or b''

    def _identity(self):
        context = os.environ.get('DOCKER_CONTEXT')
        host = os.environ.get('DOCKER_HOST')
        if context:
            kind = 'context'
        elif host:
            kind, context = 'host', None
        else:
            kind = 'context'
            context = self._run(['context', 'show']).decode().strip()
        if kind == 'context':
            if not context or len(context) > 1024 or context.startswith('-'):
                raise SetupError('Choose a valid Docker context, then run ./scripts/setup.sh again.')
            endpoint = parse_json(self._run(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']))
        else:
            endpoint = host
        if not isinstance(endpoint, str) or not endpoint or len(endpoint) > 16384:
            raise SetupError('Docker did not report a usable connection endpoint.')
        projection = '{"ID":{{json .ID}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}},"ServerErrors":{{json .ServerErrors}},"OperatingSystem":{{json .OperatingSystem}},"SecurityOptions":{{json .SecurityOptions}}}'
        info = parse_json(self._run(['info', '--format', projection]))
        if not isinstance(info, dict) or not isinstance(info.get('ID'), str) or not info['ID']:
            raise SetupError('Docker did not report a valid daemon identity.')
        if info.get('OSType') != 'linux' or info.get('Architecture') not in ('amd64', 'x86_64'):
            raise SetupError('GeoCluster needs a Linux x64 Docker environment. Choose a Linux x64 Docker host, then run ./scripts/setup.sh again.', 'platform')
        if info.get('ServerErrors') not in (None, []):
            raise SetupError('The selected Docker daemon reports server errors. Resolve them, then run ./scripts/setup.sh again.')
        options = info.get('SecurityOptions')
        system = info.get('OperatingSystem')
        if not isinstance(options, list) or any(not isinstance(item, str) for item in options) or not isinstance(system, str):
            raise SetupError('Docker did not report complete platform metadata.')
        local = (sys.platform == 'linux' and not host and not os.environ.get('DOCKER_CONTEXT') and context == 'default'
                 and endpoint in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock')
                 and 'desktop' not in system.lower()
                 and not any('rootless' in item.lower() or 'userns' in item.lower() for item in options))
        label = 'local Linux Docker' if local else ('remote Docker connection' if endpoint.startswith(('tcp:', 'ssh:', 'http:', 'https:')) else 'custom Docker connection')
        return {'selector': kind, 'context': context, 'endpoint': endpoint, 'ID': info['ID'], 'OSType': info['OSType']}, label, local

    def check(self, expected=None):
        identity, _, _ = self._identity()
        if canonical_hash(identity) != (expected or self.fingerprint):
            raise SetupError('Your Docker connection changed during setup. Choose the connection you want to use, then run ./scripts/setup.sh again.', 'docker_changed')

    def image(self, reference):
        _text(reference, 1024)
        if reference.startswith('-'):
            raise SetupError('Enter an installed image name or ID.')
        self.check()
        try:
            values = parse_json(self._run(['image', 'inspect', reference, '--format', '{{json .}}']))
        except SetupError as error:
            raise SetupError('We could not find the selected GeoCluster image on this Docker host. Run ./scripts/setup.sh to build GeoCluster or choose an installed image.', 'image_missing') from error
        if not isinstance(values, dict) or values.get('Os') != 'linux' or values.get('Architecture') != 'amd64' or not IMAGE_ID.fullmatch(values.get('Id', '')):
            raise SetupError('This image needs Linux x64 and the current GeoCluster setup helper.', 'image_incompatible')
        self.check()
        try:
            caps = parse_json(self._run(['run', '--pull=never', '--rm', '--read-only', '--network', 'none', '--user', '0:0', '--entrypoint', 'python3', values['Id'], '/opt/geocluster-runtime/setup-workspace.py', '--capabilities']))
        except SetupError as error:
            raise SetupError('This image does not include the current GeoCluster setup helper. Choose a current image or build GeoCluster.', 'image_incompatible') from error
        if (not isinstance(caps, dict) or type(caps.get('protocol')) is not int or caps['protocol'] != 1
                or any(caps.get(key) is not True for key in ('initialize', 'import', 'export'))
                or not isinstance(caps.get('bundles'), list) or 'wattle-creek/v1' not in caps['bundles']):
            raise SetupError('This image does not support the current setup and file-transfer protocol.', 'image_incompatible')
        return {'reference': reference, 'id': values['Id'], 'created': values.get('Created') or 'unknown'}

    def volume_exists(self, name):
        validate_storage({'kind': 'volume', 'name': name})
        self.check()
        try:
            actual = parse_json(self._run(['volume', 'inspect', name, '--format', '{{json .Name}}']))
        except SetupError as error:
            if error.code == 'volume_missing':
                return False
            raise
        if actual != name:
            raise SetupError('Docker reported an unexpected workspace volume identity.')
        return True

    def ensure_volume(self, name):
        if not self.volume_exists(name):
            self.check()
            self._run(['volume', 'create', name])

    def _mount(self, storage, readonly=False):
        validate_storage(storage)
        if storage['kind'] == 'bind':
            if not self.local_host:
                raise SetupError('This Docker connection does not support guided setup of a local folder. Choose Docker-managed storage.', 'host_unsupported')
            source = storage['path']
            from setup_host import validate_existing_root
            try:
                validate_existing_root(source)
            except (ValueError, OSError) as error:
                raise SetupError(str(error), 'host_root') from error
            fields = ['type=bind', 'src=' + source, 'dst=/workspace']
        else:
            fields = ['type=volume', 'src=' + storage['name'], 'dst=/workspace']
        if readonly:
            fields.append('readonly')
        output = io.StringIO()
        csv.writer(output, lineterminator='').writerow(fields)
        return output.getvalue()

    def inspect(self, storage, project, image_id):
        validate_project(project)
        validate_storage(storage)
        self.check()
        if storage['kind'] == 'volume' and not self.volume_exists(storage['name']):
            return {'exists': False, 'children': [], 'samples': []}
        if storage['kind'] == 'bind' and not os.path.lexists(storage['path']):
            return {'exists': False, 'children': [], 'samples': []}
        args = ['run', '--pull=never', '--rm', '--read-only', '--network', 'none', '--user', '0:0', '--mount', self._mount(storage, True), '--entrypoint', 'python3', image_id,
                '/opt/geocluster-runtime/setup-workspace.py', 'inspect', '--project', project]
        self.check()
        return parse_json(self._run(args))

    def operation(self, storage, image_id, args, input_file=None, output_file=None):
        if not IMAGE_ID.fullmatch(image_id):
            raise SetupError('Select an immutable GeoCluster image before using this workspace.')
        self.check()
        if storage['kind'] == 'volume' and not self.volume_exists(storage['name']):
            raise SetupError('The selected workspace volume is missing. Run ./scripts/setup.sh to prepare it.', 'workspace_missing')
        command = ['run', '--pull=never', '--rm', '--network', 'none', '--user', '0:0']
        if input_file is not None:
            command.append('-i')
        command += ['--mount', self._mount(storage), '--entrypoint', 'python3', image_id,
                    '/opt/geocluster-runtime/lifecycle-lock.py', '/workspace', 'native',
                    'python3', '/opt/geocluster-runtime/setup-workspace.py', *args]
        self.check()
        raw = self._run(command, input_file=input_file, output_file=output_file)
        return None if output_file is not None else parse_json(raw)


def prepare_import(source):
    try:
        manifest = capture_source(source)
        validate_archive_headers(manifest)
    except (ValueError, OSError) as error:
        raise _source_error(error, source, 'source_invalid') from error
    return manifest, manifest['restricted']


def import_source(docker, storage, image_id, project, destination, source, allow_restricted, expect='existing', manifest=None):
    validate_project(project)
    validate_destination(destination)
    if manifest is None:
        manifest, _ = prepare_import(source)
    if manifest['restricted'] and not allow_restricted:
        raise SetupError('Review access to private source files before copying them.', 'permission_required')
    with tempfile.TemporaryFile() as archive, tempfile.TemporaryFile() as framed:
        try:
            length = build_archive(source, manifest, archive)
        except (ValueError, OSError) as error:
            raise _source_error(error, source, 'source_changed') from error
        header = json.dumps({'project': project, 'destination': destination,
                             'allowRestricted': allow_restricted, 'manifestHash': canonical_hash(manifest),
                             'archiveLength': length, 'expect': expect}, sort_keys=True).encode()
        if len(header) > 8192:
            raise SetupError('The import header is too large.')
        framed.write(struct.pack('!I', len(header)))
        framed.write(header)
        archive.seek(0)
        while chunk := archive.read(1024 * 1024):
            framed.write(chunk)
        framed.seek(0)
        return docker.operation(storage, image_id, ['import'], input_file=framed)


def explicit_command(profile):
    validate_profile(profile)
    storage = profile['storage']
    return [str(REPO / 'scripts/run-runtime-tui.sh'), '--image', profile['image']['id'],
            '--workspace-volume' if storage['kind'] == 'volume' else '--workspace-root',
            storage.get('name', storage.get('path')), '--require-existing-workspace']


def launch(profile):
    validate_profile(profile)
    docker = Docker()
    try:
        docker.check(profile['docker']['fingerprint'])
    except SetupError as error:
        raise SetupError("This workspace uses a different Docker connection. Run ./scripts/setup.sh to choose where you'd like to work.", 'docker_changed') from error
    try:
        docker.image(profile['image']['id'])
    except SetupError as error:
        if error.code == 'image_missing':
            raise SetupError('The saved GeoCluster image is no longer installed. Run ./scripts/setup.sh to build GeoCluster or choose an installed image.', error.code) from error
        raise
    info = docker.inspect(profile['storage'], NATIVE_PROJECT, profile['image']['id'])
    if not info.get('exists'):
        raise SetupError("We couldn't find the saved workspace content in default/ inside the selected storage. Retain your files and run ./scripts/setup.sh to choose or prepare workspace storage.", 'workspace_missing')
    docker.check(profile['docker']['fingerprint'])
    print('Opening workspace', flush=True)
    return subprocess.call(['bash', *explicit_command(profile)], cwd=REPO)


def allowed_host_base():
    from setup_host import allowed_host_base as implementation
    return implementation()


def host_root_plan(path):
    from setup_host import host_root_plan as implementation
    try:
        return implementation(path)
    except (ValueError, OSError) as error:
        raise SetupError(str(error), 'host_root') from error


def create_host_root(plan):
    from setup_host import create_host_root as implementation
    try:
        return implementation(plan)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SetupError('We could not get administrator access to create this folder. Choose Docker-managed storage or retry the host-folder operation.', 'host_root') from error
