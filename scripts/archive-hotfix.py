from __future__ import annotations

import gzip
from pathlib import Path
import sys
import tarfile

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
epoch = int(__import__('os').environ.get('SOURCE_DATE_EPOCH', '0'))

with target.open('wb') as raw:
    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for path in sorted(source.rglob('*'), key=lambda item: item.relative_to(source).as_posix()):
                name = path.relative_to(source).as_posix()
                info = archive.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = 'root'
                info.mtime = epoch
                info.mode = 0o755 if path.is_dir() or name == 'apply-hotfix.sh' else 0o644
                if path.is_file():
                    with path.open('rb') as handle:
                        archive.addfile(info, handle)
                else:
                    archive.addfile(info)
