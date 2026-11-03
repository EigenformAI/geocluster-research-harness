"""Create-only, descriptor-relative transfers shared by setup and the host client.

Archives are uncompressed USTAR with 10240-byte records: the first member is a
bounded JSON manifest, followed by exactly its sorted members. No tar extraction
API is used.
"""
import ctypes
import errno
import hashlib
import json
import os
import re
import stat
import tarfile
import uuid

MANIFEST_NAME = '.geocluster-manifest.json'
MAX_MANIFEST = 16 * 1024 * 1024
MAX_ENTRIES = 100000
MAX_BYTES = (1 << 63) - 1
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
RESERVED = {'.runtime', '.ide-state', '.git', '.upload-tmp', '.datasets-staging',
            '.clinerules', '.preprocessing', 'datasets', '_orchestrator', MANIFEST_NAME}


class TransferError(ValueError):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details


def fail(code, message, **details):
    raise TransferError(code, message, **details)


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode('utf-8')


def canonical_hash(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def parse_json(data, maximum=MAX_MANIFEST):
    if len(data) > maximum:
        fail('invalid_json', 'JSON record exceeds its size limit')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail('invalid_json', 'Duplicate JSON key: ' + key)
            result[key] = value
        return result
    def constant(value):
        fail('invalid_json', 'Non-finite JSON numbers are not allowed')
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        fail('invalid_json', 'Invalid bounded UTF-8 JSON: ' + str(error))


def reserved(name):
    return name in RESERVED or name.startswith('.gc-file-') or name == '.env' or name.startswith('.env.')


def validate_path(value, *, root=False):
    if root and value == '.':
        return value
    if not isinstance(value, str) or not value or len(value.encode('utf-8', 'surrogatepass')) > 4096:
        fail('invalid_path', 'Use a bounded canonical relative path')
    if '\\' in value or any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value):
        fail('invalid_path', 'Paths cannot contain controls, backslashes, or invalid Unicode')
    parts = value.split('/')
    if any(part in ('', '.', '..') or len(part.encode('utf-8')) > 255 for part in parts):
        fail('invalid_path', 'Use a canonical relative path without dot or empty components')
    if any(reserved(part) for part in parts):
        fail('reserved_path', 'Private and reserved paths cannot be transferred', path=value)
    if len(parts) > 64:
        fail('invalid_path', 'Directory nesting exceeds 64 components')
    return value


def validate_project(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value) or value == 'datasets':
        fail('invalid_project', 'Project must have 1–64 letters, numbers, hyphens or underscores, start with a letter or number, and not be datasets')
    return value


def validate_destination(value):
    validate_path(value)
    if '/' in value or len(value.encode('utf-8')) > 255:
        fail('invalid_destination', 'Destination must be one non-reserved child name')
    return value


def mount_id(fd):
    with open('/proc/self/fdinfo/' + str(fd), encoding='ascii') as stream:
        for line in stream:
            if line.startswith('mnt_id:'):
                return int(line.split(':', 1)[1])
    fail('unsafe_path', 'Linux mount identity is unavailable')


def identity(fd):
    info = os.fstat(fd)
    return {'device': info.st_dev, 'inode': info.st_ino, 'mount': mount_id(fd)}


def same_mount(left, right):
    if os.fstat(left).st_dev != os.fstat(right).st_dev or mount_id(left) != mount_id(right):
        fail('unsafe_path', 'Transfers cannot cross filesystem or mount boundaries')


def reject_acl(fd):
    for name in ('system.posix_acl_access', 'system.posix_acl_default'):
        try:
            os.getxattr(fd, name)
        except OSError as error:
            if error.errno not in (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP):
                raise
        else:
            fail('unsafe_workspace', 'Protected objects cannot have extended or default ACLs')


def drop_acl(fd):
    # Only called on objects just created by this transfer. Never repair inputs.
    for name in ('system.posix_acl_access', 'system.posix_acl_default'):
        try:
            os.removexattr(fd, name)
        except OSError as error:
            if error.errno not in (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP):
                raise


def own_created(fd, *, service_ownership=False):
    owner = (999, 999) if service_ownership else (os.geteuid(), os.getegid())
    info = os.fstat(fd)
    if (info.st_uid, info.st_gid) != owner:
        os.fchown(fd, *owner)


def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def open_absolute(path):
    value = os.fspath(path)
    if not os.path.isabs(value) or value != os.path.normpath(value) or value.startswith('//'):
        fail('unsafe_path', 'Use a canonical absolute directory path')
    fd = os.open('/', DIRECTORY_FLAGS)
    try:
        for part in value.split('/')[1:]:
            if not part:
                continue
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def reject_entry(info, path, expected):
    kinds = ((stat.S_ISLNK, 'symlink', 'Symbolic links'),
             (stat.S_ISFIFO, 'fifo', 'Named pipes (FIFOs)'),
             (stat.S_ISSOCK, 'socket', 'Sockets'),
             (stat.S_ISCHR, 'character_device', 'Character devices'),
             (stat.S_ISBLK, 'block_device', 'Block devices'),
             (stat.S_ISREG, 'file', 'Ordinary files'),
             (stat.S_ISDIR, 'directory', 'Directories'))
    kind, label = next(((kind, label) for check, kind, label in kinds if check(info.st_mode)),
                       ('unknown', 'Unsupported object types'))
    if kind == 'symlink':
        hint = ('Choose a data-only folder, or prepare a separate import copy without '
                'symbolic links. Original files are not changed.')
    else:
        hint = ('Prepare a separate import copy without this object, using only ordinary '
                'files and directories. Original files are not changed.')
    message = ('Expected an ordinary ' + expected if kind in ('file', 'directory') else
               label + ' are not supported by workspace imports')
    fail('unsafe_path', message, path=path, entry_type=kind, hint=hint, path_scope='transfer_source')


def reject_hardlinks(path):
    fail('unsafe_path', 'Multiple hardlinks are not supported', path=path, entry_type='file', path_scope='transfer_source',
         hint='Prepare a separate import copy with independent ordinary files instead of multiple hardlinks. Original files are not changed.')


def open_child(parent, name, *, directory=False, path=None, transfer_source=False):
    # Diagnostic context never changes the descriptor-relative lookup name.
    # Only content callers opt in; private workspace checks keep generic errors.
    path = name if path is None else path
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not (stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)):
        expected = 'directory' if directory else 'file'
        if transfer_source:
            reject_entry(before, path, expected)
        fail('unsafe_path', 'Expected an ordinary ' + expected, path=path)
    if not directory and before.st_nlink != 1:
        if transfer_source:
            reject_hardlinks(path)
        fail('unsafe_path', 'Multiple hardlinks are not supported', path=path)
    fd = os.open(name, DIRECTORY_FLAGS if directory else FILE_FLAGS, dir_fd=parent)
    try:
        if snapshot(before) != snapshot(os.fstat(fd)):
            fail('source_changed', 'Path identity changed while opening', path=path)
        same_mount(parent, fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_relative(parent, path, *, directory=True, transfer_source=False):
    validate_path(path, root=True)
    fd = os.dup(parent)
    try:
        if path == '.':
            return fd
        parts = path.split('/')
        for index, part in enumerate(parts):
            child = open_child(fd, part, directory=directory or index < len(parts) - 1,
                               path='/'.join(parts[:index + 1]), transfer_source=transfer_source)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def assert_named(parent, name, fd, *, path=None):
    path = name if path is None else path
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (info.st_dev, info.st_ino) != (os.fstat(fd).st_dev, os.fstat(fd).st_ino):
        fail('unsafe_path', 'A held path was replaced', path=path)
    check = os.open(name, DIRECTORY_FLAGS if stat.S_ISDIR(info.st_mode) else FILE_FLAGS, dir_fd=parent)
    try:
        if identity(check) != identity(fd):
            fail('unsafe_path', 'A held mount was replaced', path=path)
    finally:
        os.close(check)


def restricted_entry(entry):
    mode = entry['mode']
    if entry['type'] == 'directory':
        return mode & 0o050 != 0o050 and mode & 0o005 != 0o005
    return not mode & 0o040


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != {'entries', 'restricted'} or not isinstance(value['entries'], list) or not isinstance(value['restricted'], list):
        fail('invalid_manifest', 'Expected entries and restricted arrays')
    entries = value['entries']
    if not 1 <= len(entries) <= MAX_ENTRIES:
        fail('invalid_manifest', 'Manifest has an invalid member count')
    seen, paths = {}, []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get('type') not in ('file', 'directory'):
            fail('invalid_manifest', 'Unsupported manifest member')
        file = entry['type'] == 'file'
        keys = {'path', 'type', 'size', 'mode'} | ({'sha256'} if file else set())
        if set(entry) != keys:
            fail('invalid_manifest', 'Unknown or missing manifest member fields')
        path = validate_path(entry['path'], root=True)
        if path in seen or (path == '.' and file):
            fail('invalid_manifest', 'Duplicate path or invalid source root')
        if type(entry['size']) is not int or not 0 <= entry['size'] <= MAX_BYTES or (not file and entry['size'] != 0):
            fail('invalid_manifest', 'Invalid member byte count')
        if type(entry['mode']) is not int or not 0 <= entry['mode'] <= 0o7777:
            fail('invalid_manifest', 'Invalid source permissions')
        if file and (not isinstance(entry['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', entry['sha256'])):
            fail('invalid_manifest', 'Invalid SHA-256 digest')
        seen[path] = entry
        paths.append(path)
    if paths != sorted(paths) or paths[0] != '.':
        fail('invalid_manifest', 'Manifest must contain a root and sorted unique paths')
    for path in paths[1:]:
        parent = path.rsplit('/', 1)[0] if '/' in path else '.'
        if parent not in seen or seen[parent]['type'] != 'directory':
            fail('invalid_manifest', 'Every member needs a declared directory parent')
    if value['restricted'] != [entry['path'] for entry in entries if restricted_entry(entry)]:
        fail('invalid_manifest', 'Restricted paths disagree with source permissions')
    if len(canonical_bytes(value)) > MAX_MANIFEST:
        fail('invalid_manifest', 'Manifest exceeds its size limit')
    return value


def capture_fd(root):
    entries, metadata = [], {}
    root_mount = mount_id(root)
    def visit(fd, path):
        before = os.fstat(fd)
        if mount_id(fd) != root_mount:
            fail('unsafe_path', 'Nested mounts are not supported', path=path, path_scope='transfer_source')
        mode = stat.S_IMODE(before.st_mode)
        entry = {'path': path, 'type': 'directory', 'size': 0, 'mode': mode}
        if stat.S_ISREG(before.st_mode):
            if before.st_nlink != 1:
                reject_hardlinks(path)
            digest = hashlib.sha256()
            os.lseek(fd, 0, os.SEEK_SET)
            size = 0
            while block := os.read(fd, 1024 * 1024):
                size += len(block)
                digest.update(block)
            if size != before.st_size:
                fail('source_changed', 'File size changed while reading', path=path)
            entry.update(type='file', size=size, sha256=digest.hexdigest())
        elif stat.S_ISDIR(before.st_mode):
            names = sorted(os.listdir(fd))
            for name in names:
                child_path = name if path == '.' else path + '/' + name
                validate_path(child_path)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                child = open_child(fd, name, directory=stat.S_ISDIR(info.st_mode), path=child_path,
                                   transfer_source=True)
                try:
                    visit(child, child_path)
                    assert_named(fd, name, child, path=child_path)
                finally:
                    os.close(child)
        else:
            reject_entry(before, path, 'file or directory')
        if snapshot(before) != snapshot(os.fstat(fd)):
            fail('source_changed', 'Content or metadata changed while reading', path=path)
        entries.append(entry)
        metadata[path] = snapshot(before)
        if len(entries) > MAX_ENTRIES:
            fail('invalid_manifest', 'Tree exceeds the member count limit')
    visit(root, '.')
    entries.sort(key=lambda entry: entry['path'])
    manifest = {'entries': entries, 'restricted': [entry['path'] for entry in entries if restricted_entry(entry)]}
    return validate_manifest(manifest), metadata


def capture_source(path):
    fd = open_absolute(os.path.abspath(path))
    try:
        return capture_fd(fd)[0]
    finally:
        os.close(fd)


def verify_tree(fd, manifest, *, service_ownership=False):
    observed, metadata = capture_fd(fd)
    if observed != manifest or (service_ownership and any(item[4:6] != (999, 999) for item in metadata.values())):
        fail('manifest_mismatch', 'Tree content, permissions, or ownership changed')


def tar_header(name, mode, size=0, *, directory=False):
    item = tarfile.TarInfo(name)
    item.mode, item.size = mode, size
    item.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
    try:
        return item.tobuf(format=tarfile.USTAR_FORMAT, encoding='utf-8', errors='strict')
    except (ValueError, UnicodeError) as error:
        message = 'This entry cannot fit the import archive format (USTAR): ' + str(error)
        if isinstance(error, UnicodeError):
            hint = 'Use valid UTF-8 filenames in a separate import copy. Original files are not changed.'
        elif str(error) == 'name is too long':
            message += '. The format limits UTF-8 bytes and nested paths, not just visible characters.'
            hint = ('Shorten the filename or nested folder names in a separate import copy. '
                    'Renaming only the selected source folder does not shorten archive member paths.')
        else:
            hint = ('Prepare a separate import copy with file sizes and metadata supported by USTAR. '
                    'Original files are not changed.')
        fail('unsupported_path', message, path=name, hint=hint, path_scope='transfer_source')


def validate_archive_headers(manifest):
    """Preflight the writer's exact headers without scanning or writing source data."""
    tar_header(MANIFEST_NAME, 0o600, len(canonical_bytes(manifest)))
    for entry in manifest['entries']:
        tar_header(entry['path'], entry['mode'], entry['size'], directory=entry['type'] == 'directory')


def write_bytes(output, block):
    remaining = memoryview(block)
    while remaining:
        written = output.write(remaining)
        if written is None or written <= 0:
            fail('io_error', 'Archive write did not make progress')
        remaining = remaining[written:]


def build_archive_fd(root, manifest, output):
    validate_manifest(manifest)
    before, metadata = capture_fd(root)
    if before != manifest:
        fail('source_changed', 'Source no longer matches the approved manifest')
    start = output.tell()
    data = canonical_bytes(manifest)
    write_bytes(output, tar_header(MANIFEST_NAME, 0o600, len(data)))
    write_bytes(output, data)
    write_bytes(output, b'\0' * (-len(data) % 512))
    for entry in manifest['entries']:
        path, directory = entry['path'], entry['type'] == 'directory'
        write_bytes(output, tar_header(path, entry['mode'], entry['size'], directory=directory))
        fd = open_relative(root, path, directory=directory, transfer_source=True)
        try:
            if snapshot(os.fstat(fd)) != metadata[path]:
                fail('source_changed', 'Source identity changed before archiving', path=path)
            if not directory:
                digest, size = hashlib.sha256(), 0
                while block := os.read(fd, 1024 * 1024):
                    size += len(block)
                    if size > entry['size']:
                        fail('source_changed', 'File grew while archiving', path=path)
                    digest.update(block)
                    write_bytes(output, block)
                if size != entry['size'] or digest.hexdigest() != entry['sha256']:
                    fail('source_changed', 'File bytes changed while archiving', path=path)
                write_bytes(output, b'\0' * (-size % 512))
            if snapshot(os.fstat(fd)) != metadata[path]:
                fail('source_changed', 'Source metadata changed while archiving', path=path)
        finally:
            os.close(fd)
    after, final_metadata = capture_fd(root)
    if after != manifest or final_metadata != metadata:
        fail('source_changed', 'Source changed during archive creation')
    write_bytes(output, b'\0' * 1024)
    write_bytes(output, b'\0' * (-(output.tell() - start) % 10240))
    output.flush()
    return output.tell() - start


def build_archive(path, manifest, output_binary_file):
    path = os.path.abspath(path)
    parent = open_absolute(os.path.dirname(path))
    fd = open_child(parent, os.path.basename(path), directory=True)
    try:
        length = build_archive_fd(fd, manifest, output_binary_file)
        assert_named(parent, os.path.basename(path), fd)
        return length
    finally:
        os.close(fd)
        os.close(parent)


def read_exact(stream, length):
    chunks = []
    while length:
        block = stream.read(min(length, 1024 * 1024))
        if not block:
            fail('invalid_archive', 'Truncated archive or transfer frame')
        chunks.append(block)
        length -= len(block)
    return b''.join(chunks)


def read_header(stream):
    block = read_exact(stream, 512)
    if block == b'\0' * 512:
        fail('invalid_archive', 'Archive ended before its declared members')
    try:
        item = tarfile.TarInfo.frombuf(block, encoding='utf-8', errors='strict')
    except (tarfile.HeaderError, UnicodeError, ValueError) as error:
        fail('invalid_archive', 'Invalid tar header: ' + str(error))
    if block[257:263] != b'ustar\0' or item.type not in (tarfile.REGTYPE, tarfile.DIRTYPE) or item.linkname or item.size < 0:
        fail('invalid_archive', 'Only uncompressed USTAR ordinary files and directories are supported')
    if item.pax_headers or item.sparse:
        fail('invalid_archive', 'Extended or sparse metadata is not supported')
    return item


def read_manifest(stream):
    item = read_header(stream)
    if item.name != MANIFEST_NAME or item.type != tarfile.REGTYPE or not 0 < item.size <= MAX_MANIFEST or item.mode != 0o600:
        fail('invalid_archive', 'The first archive member must be the bounded manifest')
    data = read_exact(stream, item.size)
    if any(read_exact(stream, -item.size % 512)):
        fail('invalid_archive', 'Nonzero tar member padding')
    return validate_manifest(parse_json(data)), 512 + item.size + (-item.size % 512)


def intended_manifest(manifest, *, service_ownership):
    entries = []
    for entry in manifest['entries']:
        copy = dict(entry)
        copy['mode'] = (0o2770 if entry['type'] == 'directory' else 0o660 | (entry['mode'] & 0o110)) if service_ownership else entry['mode'] & 0o777
        entries.append(copy)
    return {'entries': entries, 'restricted': [entry['path'] for entry in entries if restricted_entry(entry)]}


def rename_noreplace(source_parent, source, destination_parent, destination):
    same_mount(source_parent, destination_parent)
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        fail('unsupported_filesystem', 'Linux renameat2(RENAME_NOREPLACE) is required')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_parent, os.fsencode(source), destination_parent, os.fsencode(destination), 1):
        number = ctypes.get_errno()
        if number in (errno.EEXIST, errno.ENOTEMPTY):
            fail('destination_exists', 'Destination already exists; choose a new child name', destination=destination)
        if number in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            fail('unsupported_filesystem', 'Atomic no-replacement publication is unavailable')
        raise OSError(number, os.strerror(number))


def extract_archive(stream, parent, name, *, service_ownership=False, expected_hash=None, allow_restricted=True):
    """Extract only into a new child of an already-held private staging parent."""
    validate_destination(name)
    manifest, consumed = read_manifest(stream)
    if expected_hash is not None and canonical_hash(manifest) != expected_hash:
        fail('manifest_mismatch', 'Archive manifest differs from the approved source')
    if manifest['restricted'] and not allow_restricted:
        fail('restricted_source', 'Restricted source permissions need explicit approval', restricted=manifest['restricted'])
    expected = intended_manifest(manifest, service_ownership=service_ownership)
    os.mkdir(name, 0o700, dir_fd=parent)
    root = open_child(parent, name, directory=True)
    try:
        drop_acl(root)
        directories = []
        for entry, target in zip(manifest['entries'], expected['entries']):
            item = read_header(stream)
            consumed += 512 + item.size + (-item.size % 512)
            directory = entry['type'] == 'directory'
            if item.name != entry['path'] or item.type != (tarfile.DIRTYPE if directory else tarfile.REGTYPE) or item.size != entry['size'] or item.mode != entry['mode']:
                fail('manifest_mismatch', 'Archive member disagrees with the manifest', path=entry['path'])
            if entry['path'] == '.':
                directories.append(target)
                continue
            parts = entry['path'].rsplit('/', 1)
            parent_path, child_name = parts if len(parts) == 2 else ('.', parts[0])
            ancestor = open_relative(root, parent_path)
            try:
                if directory:
                    os.mkdir(child_name, 0o700, dir_fd=ancestor)
                    child = open_child(ancestor, child_name, directory=True)
                    try:
                        drop_acl(child)
                    finally:
                        os.close(child)
                    directories.append(target)
                    continue
                fd = os.open(child_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=ancestor)
                try:
                    drop_acl(fd)
                    digest, remaining = hashlib.sha256(), entry['size']
                    while remaining:
                        block = read_exact(stream, min(remaining, 1024 * 1024))
                        digest.update(block)
                        write_all(fd, block)
                        remaining -= len(block)
                    if digest.hexdigest() != entry['sha256']:
                        fail('manifest_mismatch', 'File digest differs from the approved manifest', path=entry['path'])
                    if any(read_exact(stream, -entry['size'] % 512)):
                        fail('invalid_archive', 'Nonzero tar member padding')
                    own_created(fd, service_ownership=service_ownership)
                    os.fchmod(fd, target['mode'])
                    os.fsync(fd)
                finally:
                    os.close(fd)
            finally:
                os.close(ancestor)
        # Our writer emits exactly two end blocks plus record alignment. Even
        # zero bytes after that exact archive are trailing bytes, not more data.
        padding = 1024 + (-(consumed + 1024) % 10240)
        if any(read_exact(stream, padding)) or stream.read(1):
            fail('invalid_archive', 'Archive has undeclared members, missing end markers, or trailing bytes')
        # Finalize deepest directories last, after every descendant was written.
        for target in sorted(directories, key=lambda entry: entry['path'].count('/') + (entry['path'] != '.'), reverse=True):
            fd = open_relative(root, target['path'])
            try:
                own_created(fd, service_ownership=service_ownership)
                os.fchmod(fd, target['mode'])
                os.fsync(fd)
            finally:
                os.close(fd)
        # Capture through held descriptors; no path-based permission repair.
        verify_tree(root, expected, service_ownership=service_ownership)
        assert_named(parent, name, root)
        os.fsync(parent)
        return manifest, expected, identity(root)
    finally:
        os.close(root)


def write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        count = os.write(fd, remaining)
        if count <= 0:
            fail('io_error', 'Write did not make progress')
        remaining = remaining[count:]


def remove_created(parent, name, expected_identity):
    """Remove only our verified temporary subtree; unsafe entries are retained."""
    fd = open_child(parent, name, directory=True)
    try:
        if identity(fd) != expected_identity:
            fail('unsafe_path', 'Temporary subtree identity changed; retained for inspection')
        def clear(directory):
            for child_name in os.listdir(directory):
                info = os.stat(child_name, dir_fd=directory, follow_symlinks=False)
                child = open_child(directory, child_name, directory=stat.S_ISDIR(info.st_mode))
                try:
                    if stat.S_ISDIR(info.st_mode):
                        clear(child)
                        assert_named(directory, child_name, child)
                        os.rmdir(child_name, dir_fd=directory)
                    else:
                        assert_named(directory, child_name, child)
                        os.unlink(child_name, dir_fd=directory)
                finally:
                    os.close(child)
            os.fsync(directory)
        clear(fd)
        assert_named(parent, name, fd)
        os.rmdir(name, dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(fd)


def safe_extract(archive_file, destination_parent_absolute_path, destination_name, *, service_ownership=False):
    validate_destination(destination_name)
    parent = open_absolute(destination_parent_absolute_path)
    temporary = '.geocluster-transfer-' + str(uuid.uuid4())
    # The outer container remains caller-owned 0700 even for service-owned data.
    os.mkdir(temporary, 0o700, dir_fd=parent)
    private = open_child(parent, temporary, directory=True)
    private_identity = identity(private)
    try:
        drop_acl(private)
        own_created(private)
        manifest, expected, tree_identity = extract_archive(archive_file, private, 'tree', service_ownership=service_ownership)
        assert_named(parent, temporary, private)
        rename_noreplace(private, 'tree', parent, destination_name)
        os.fsync(parent)
        os.fsync(private)
        return {'destination': destination_name, 'state': 'verified', 'manifestHash': canonical_hash(manifest)}
    finally:
        os.close(private)
        try:
            remove_created(parent, temporary, private_identity)
        except (OSError, ValueError):
            # Uncertain temporary objects are never permission-repaired or removed.
            pass
        os.close(parent)
