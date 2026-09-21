"""Server-side archive operations using Python 3 standard libraries only.

Invoked with -I and one JSON argument through the existing SSH channel.
Extraction is manual: no extractall, links, device nodes, or path traversal.
"""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import zipfile

MAX_ITEMS = 100000
MAX_BYTES = 100 * 1024 ** 3


def unique_path(parent, stem, suffix, directory=False):
    for number in range(1, 10001):
        target = parent / (stem + ("" if number == 1 else " (%d)" % number) + suffix)
        try:
            if directory:
                target.mkdir(mode=0o700)
                return target, None
            return target, target.open("xb")
        except FileExistsError:
            continue
    raise ValueError("Too many destination name conflicts")


def source_entries(paths, parent):
    entries = []
    total = 0
    pending = list(reversed(paths))
    while pending:
        source = pending.pop()
        info = source.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError("Links and special files are not supported: %s" % source)
        if os.path.commonpath([str(parent), str(source.resolve())]) != str(parent):
            raise ValueError("Source path changed: %s" % source)
        entries.append((source, source.relative_to(parent).as_posix(), info))
        total += info.st_size if stat.S_ISREG(info.st_mode) else 0
        if len(entries) > MAX_ITEMS or total > MAX_BYTES:
            raise ValueError("Archive exceeds 100000 entries or 100 GiB")
        if stat.S_ISDIR(info.st_mode):
            pending.extend(sorted(source.iterdir(), reverse=True))
    return entries


def opened_regular(source, expected):
    descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    actual = os.fstat(descriptor)
    if not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns) != (expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns):
        os.close(descriptor)
        raise ValueError("Source changed during archiving: %s" % source)
    return os.fdopen(descriptor, "rb")


def compress(parent, paths, format_name):
    if format_name not in ("tar.gz", "zip"):
        raise ValueError("Supported archive formats: tar.gz, zip")
    entries = source_entries(paths, parent)
    stem = paths[0].name if len(paths) == 1 else "Archive"
    target, destination = unique_path(parent, stem, "." + format_name)
    try:
        with destination:
            if format_name == "zip":
                with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                    for source, name, info in entries:
                        if stat.S_ISDIR(info.st_mode):
                            archive.writestr(name.rstrip("/") + "/", b"")
                        else:
                            with opened_regular(source, info) as incoming, archive.open(name, "w", force_zip64=True) as outgoing:
                                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            else:
                with tarfile.open(fileobj=destination, mode="w:gz") as archive:
                    for source, name, info in entries:
                        member = tarfile.TarInfo(name)
                        member.mode = stat.S_IMODE(info.st_mode) & 0o777
                        member.mtime = info.st_mtime
                        if stat.S_ISDIR(info.st_mode):
                            member.type = tarfile.DIRTYPE
                            archive.addfile(member)
                        else:
                            member.size = info.st_size
                            with opened_regular(source, info) as incoming:
                                archive.addfile(member, incoming)
        return target
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def safe_member(name):
    if not name or name.startswith("/") or "\\" in name or ":" in name or any(ord(char) < 32 for char in name):
        raise ValueError("Unsafe archive entry: %r" % name)
    parts = PurePosixPath(name).parts
    if not parts or ".." in parts:
        raise ValueError("Unsafe archive entry: %r" % name)
    return parts


def extract(parent, source):
    expected = source.lstat()
    with opened_regular(source, expected) as incoming:
        is_zip = source.name.lower().endswith(".zip")
        if not is_zip and not source.name.lower().endswith((".tar.gz", ".tgz", ".tar")):
            raise ValueError("Supported archives: .zip, .tar.gz, .tgz, .tar")
        archive = zipfile.ZipFile(incoming) if is_zip else tarfile.open(fileobj=incoming, mode="r:*")
        with archive:
            entries = []
            total = 0
            member_count = 0
            occupied = {}
            parent_keys = set()
            members = archive.infolist() if is_zip else archive
            for member in members:
                member_count += 1
                if member_count > MAX_ITEMS:
                    raise ValueError("Archive exceeds 100000 entries or 100 GiB")
                name = member.filename if is_zip else member.name
                directory = member.is_dir() if is_zip else member.isdir()
                mode = (member.external_attr >> 16) if is_zip else 0
                if (is_zip and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or (not is_zip and not (member.isfile() or member.isdir())):
                    raise ValueError("Archive links and special files are not supported: %s" % name)
                if directory and name in (".", "./"):
                    continue
                parts = safe_member(name)
                key = "/".join(parts)
                if key in occupied or any(occupied.get("/".join(parts[:length])) is False for length in range(1, len(parts))):
                    raise ValueError("Conflicting archive entries: %s" % name)
                if not directory and key in parent_keys:
                    raise ValueError("Conflicting archive entries: %s" % name)
                occupied[key] = directory
                parent_keys.update("/".join(parts[:length]) for length in range(1, len(parts)))
                size = member.file_size if is_zip else member.size
                if not isinstance(size, int) or size < 0:
                    raise ValueError("Invalid archive entry size: %s" % name)
                total += size
                entries.append((member, parts, directory, size))
                if len(entries) > MAX_ITEMS or total > MAX_BYTES:
                    raise ValueError("Archive exceeds 100000 entries or 100 GiB")
            if total > shutil.disk_usage(parent).free:
                raise ValueError("Insufficient server disk space for extraction")
            stem = source.name
            for suffix in (".tar.gz", ".tgz", ".tar", ".zip"):
                if stem.lower().endswith(suffix):
                    stem = stem[:-len(suffix)]
                    break
            target, _ = unique_path(parent, stem or "Extracted", "", directory=True)
            try:
                for member, parts, directory, size in entries:
                    output = target.joinpath(*parts)
                    if directory:
                        output.mkdir(mode=0o700, parents=True, exist_ok=True)
                        continue
                    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    reader = archive.open(member) if is_zip else archive.extractfile(member)
                    with reader, output.open("xb") as writer:
                        copied = 0
                        while True:
                            block = reader.read(1024 * 1024)
                            if not block:
                                break
                            copied += len(block)
                            if copied > size:
                                raise ValueError("Archive entry exceeds declared size")
                            writer.write(block)
                        if copied != size:
                            raise ValueError("Archive entry is truncated")
                return target
            except BaseException:
                # Only the freshly reserved extraction directory belongs to us.
                shutil.rmtree(target)
                raise


def run(request):
    parent = Path(request["parent"]).resolve(strict=True)
    paths = [Path(value) for value in request["paths"]]
    if not parent.is_dir() or not paths or len(paths) > 1000:
        raise ValueError("Invalid archive selection")
    if len(set(map(str, paths))) != len(paths) or any(item.parent.resolve(strict=True) != parent for item in paths):
        raise ValueError("Archive sources must be direct children of the selected directory")
    # The selected parent may be a legitimate directory symlink. Canonicalize
    # only its ancestors; the final source is still checked with lstat and
    # O_NOFOLLOW, so selecting a symbolic-link file remains rejected.
    paths = [parent / item.name for item in paths]
    if request["operation"] == "compress":
        output = compress(parent, paths, request.get("format", "tar.gz"))
        return [str(Path(request["parent"]) / output.name)]
    if request["operation"] == "extract" and len(paths) == 1:
        output = extract(parent, paths[0])
        return [str(Path(request["parent"]) / output.name)]
    raise ValueError("Unsupported archive operation")


if __name__ == "__main__":
    try:
        if sys.version_info < (3, 8):
            raise RuntimeError("Python 3.8 or later is required")
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")
        print(json.dumps({"paths": run(json.loads(sys.argv[1]))}, ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
