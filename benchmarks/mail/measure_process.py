"""One fresh child process: record its OS-reported high-water RSS in KiB."""
import json
from pathlib import Path
import resource
import subprocess
import sys
result=subprocess.run(sys.argv[2:])
Path(sys.argv[1]).write_text(json.dumps({'peakRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}))
raise SystemExit(result.returncode)
